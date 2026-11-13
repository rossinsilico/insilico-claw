import { openSocket, type SocketConnection } from "../native/socket";
import { signGatewayChallenge } from "../native/gateway-identity";
import { traceAssistantStage } from "../native/assistant-trace";
import { buildQuestionResolution, gatewayQuestionScopes, type OpenClawQuestionRecord } from "./openclaw-questions";
import type { AssistantQuestionSignal, AssistantTurnCallbacks } from "./types";

const METHODS = ["question.list", "question.get", "question.resolve", "plugin.approval.list", "plugin.approval.resolve"];
const EVENTS = ["question.requested", "question.resolved", "plugin.approval.requested", "plugin.approval.resolved"];

/** NativeScript does not provide the browser AbortController on every platform. */
class PromptLifetime implements AssistantQuestionSignal {
  aborted = false;
  private listeners = new Set<() => void>();
  addEventListener(_event: "abort", listener: () => void): void { this.listeners.add(listener); }
  removeEventListener(_event: "abort", listener: () => void): void { this.listeners.delete(listener); }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

type Binding = { runId: string; sessionKey: string; lifetime: PromptLifetime };
type PendingRpc = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type PluginApproval = { id: string; createdAtMs: number; expiresAtMs: number; request: {
  sessionKey: string; runId: string; title: string; description: string; detail?: string;
  pluginId?: string; toolName?: string; toolCallId?: string; mcpTool?: { server: string; tool: string }; allowedDecisions?: string[];
} };

/** One paired answer surface for one HTTP turn. A disconnect ends the turn; it never replays consent. */
export class OpenClawInputClient {
  private socket: SocketConnection | null = null;
  private pending = new Map<string, PendingRpc>();
  private sequence = 0;
  private closed = false;
  private connectionId = "";
  private binding: Binding | null = null;
  private scanning = false;
  private scanAgain = false;
  private shown = new Set<string>();
  private prompt: { id: string; lifetime: PromptLifetime } | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: {
    baseUrl: string; apiKey: string;
    onQuestion: NonNullable<AssistantTurnCallbacks["onQuestion"]>;
    onError(message: string): void;
  }) {}

  connect(): Promise<string> {
    traceAssistantStage("input.started");
    // The reserved OpenClaw API is rooted at /v1. Do not guess paths or downgrade TLS.
    const match = /^https:\/\/([^/\s?#@\\]+)\/v1\/?$/.exec(this.options.baseUrl.trim().replace(/\/chat\/completions\/?$/, ""));
    if (!match || !this.options.apiKey.trim()) return Promise.reject(new Error("OpenClaw confirmations require its private HTTPS /v1 URL and saved key"));
    const origin = `https://${match[1]}`;
    return new Promise((resolve, reject) => {
      this.connectReject = reject;
      this.connectTimer = setTimeout(() => this.fail("OpenClaw confirmation connection timed out"), 15000);
      let challengeReceived = false;
      this.socket = openSocket(`wss://${match[1]}/`, {
        onOpen() {},
        onClosed: () => this.fail("OpenClaw confirmation connection closed; this request was cancelled"),
        onFailure: () => this.fail("OpenClaw confirmation connection failed; this request was cancelled"),
        onTextMessage: (text) => {
          if (this.closed) return;
          try {
            const frame = JSON.parse(text);
            if (frame.type === "res") {
              const waiting = this.pending.get(frame.id);
              if (!waiting) return;
              this.pending.delete(frame.id); clearTimeout(waiting.timer);
              if (frame.ok) waiting.resolve(frame.payload);
              else waiting.reject(new Error(frame.error?.details?.code === "PAIRING_REQUIRED" || /pairing required/i.test(frame.error?.message ?? "")
                ? "Pair FaceClaw Pilot's confirmation device in OpenClaw, then retry"
                : String(frame.error?.message ?? "OpenClaw rejected the confirmation request")));
              return;
            }
            if (frame.type !== "event") return;
            if (frame.event === "connect.challenge" && !challengeReceived) {
              challengeReceived = true;
              const { nonce, ts } = frame.payload ?? {};
              if (typeof nonce !== "string" || !nonce || !Number.isSafeInteger(ts) || ts < 0) throw new Error("Invalid OpenClaw device challenge");
              const scopes = gatewayQuestionScopes(true);
              const device = signGatewayChallenge(origin, this.options.apiKey.trim(), scopes, nonce, ts);
              void this.rpc("connect", {
                minProtocol: 4, maxProtocol: 4,
                client: { id: "webchat-ui", version: "0.9.0-pilot", platform: "ios", deviceFamily: "iphone", mode: "ui" },
                role: "operator", scopes, caps: ["approvals"],
                auth: { token: this.options.apiKey.trim() }, device,
              }).then(hello => {
                if (this.closed) return;
                if (hello?.type !== "hello-ok" || hello.protocol !== 4 || !hello.server?.connId || hello.auth?.role !== "operator" ||
                    !scopes.every(scope => hello.auth?.scopes?.includes(scope)) ||
                    !METHODS.every(method => hello.features?.methods?.includes(method)) || !EVENTS.every(event => hello.features?.events?.includes(event))) {
                  throw new Error("OpenClaw did not grant the required confirmation capabilities");
                }
                this.connectionId = hello.server.connId;
                traceAssistantStage("input.connected");
                if (this.connectTimer) clearTimeout(this.connectTimer);
                this.connectTimer = null; this.connectReject = null;
                resolve(this.connectionId);
              }).catch(error => this.fail(error.message));
            } else if (EVENTS.includes(frame.event)) {
              traceAssistantStage("input.question-event", this.binding ? 1 : 0);
              const id = frame.payload?.id;
              if (frame.event.endsWith(".resolved") && id === this.prompt?.id) this.prompt.lifetime.abort();
              this.refresh();
            } else if (frame.event === "shutdown") this.fail("OpenClaw restarted; retry the request");
          } catch (error) { this.fail(String((error as Error).message)); }
        },
      }, { name: "Origin", value: origin });
    });
  }

  bindRun(runId: string, sessionKey: string, connectionId: string): void {
    if (this.closed || !this.connectionId || connectionId !== this.connectionId || !runId || !sessionKey) throw new Error("OpenClaw confirmation binding was not verified");
    if (this.binding?.runId === runId && this.binding.sessionKey === sessionKey) return;
    this.endRun();
    this.binding = { runId, sessionKey, lifetime: new PromptLifetime() };
    traceAssistantStage("input.bound");
    this.refresh();
  }

  endRun(): void {
    this.binding?.lifetime.abort(); this.binding = null;
    this.prompt?.lifetime.abort(); this.prompt = null;
    this.shown.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.endRun();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.connectReject?.(new Error("OpenClaw confirmation cancelled")); this.connectReject = null;
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("OpenClaw confirmation cancelled")); }
    this.pending.clear(); this.socket?.close(1000, "Turn ended"); this.socket = null;
  }

  private fail(message: string): void {
    if (this.closed) return;
    traceAssistantStage("input.failed");
    this.connectReject?.(new Error(message)); this.connectReject = null;
    this.close(); this.options.onError(message);
  }

  private rpc(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("OpenClaw confirmation connection is closed"));
    return new Promise((resolve, reject) => {
      const id = `faceclaw-${++this.sequence}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("OpenClaw confirmation response timed out; do not repeat the action without checking its result")); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.socket?.sendText(JSON.stringify({ type: "req", id, method, params }))) {
        this.pending.delete(id); clearTimeout(timer); reject(new Error("OpenClaw confirmation connection is unavailable"));
      }
    });
  }

  private current(binding: Binding): boolean { return !this.closed && this.binding === binding && !binding.lifetime.aborted; }

  private refresh(): void {
    if (!this.binding || this.closed) return;
    if (this.scanning) { this.scanAgain = true; return; }
    this.scanning = true;
    const binding = this.binding;
    void this.scan(binding).catch(error => { if (this.current(binding)) this.fail(error.message); }).finally(() => {
      this.scanning = false;
      if (this.scanAgain) { this.scanAgain = false; this.refresh(); }
    });
  }

  private async scan(binding: Binding): Promise<void> {
    traceAssistantStage("input.scan");
    const [questionResult, approvals] = await Promise.all([this.rpc("question.list", {}), this.rpc("plugin.approval.list", {})]);
    if (!this.current(binding)) return;
    const records: OpenClawQuestionRecord[] = questionResult.questions ?? [];
    traceAssistantStage("input.total-questions", records.length);
    traceAssistantStage("input.other-session", records.filter(q => q.sessionKey !== binding.sessionKey).length);
    traceAssistantStage("input.other-run", records.filter(q => q.sessionKey === binding.sessionKey && q.runId !== binding.runId).length);
    const questions: OpenClawQuestionRecord[] = (questionResult.questions ?? []).filter((q: OpenClawQuestionRecord) =>
      q.sessionKey === binding.sessionKey && q.runId === binding.runId && q.status === "pending" && q.expiresAtMs > Date.now());
    const plugins: PluginApproval[] = (Array.isArray(approvals) ? approvals : []).filter((a: PluginApproval) =>
      a.request?.sessionKey === binding.sessionKey && a.request?.runId === binding.runId && a.expiresAtMs > Date.now());
    traceAssistantStage("input.question-count", questions.length);
    traceAssistantStage("input.approval-count", plugins.length);
    if (questions.length + plugins.length > 1) throw new Error("Multiple confirmations are pending for this request; retry one action at a time");
    const record = questions[0] ?? plugins[0];
    if (!record || this.shown.has(record.id)) return;
    this.shown.add(record.id);
    const lifetime = new PromptLifetime();
    this.prompt = { id: record.id, lifetime };
    const cancel = () => lifetime.abort();
    binding.lifetime.addEventListener("abort", cancel);
    const timer = setTimeout(cancel, Math.max(0, record.expiresAtMs - Date.now()));
    try {
      if (questions[0]) await this.answerQuestion(questions[0], binding, lifetime);
      else await this.answerPlugin(plugins[0]!, binding, lifetime);
    } finally {
      clearTimeout(timer); lifetime.abort(); binding.lifetime.removeEventListener("abort", cancel);
      if (this.prompt?.lifetime === lifetime) this.prompt = null;
    }
  }

  private async answerQuestion(record: OpenClawQuestionRecord, binding: Binding, lifetime: PromptLifetime): Promise<void> {
    if (!record.questions?.length || record.questions.some(q => q.isSecret || q.resource !== undefined || q.multiSelect || !q.options?.length)) {
      traceAssistantStage("question.unsupported");
      await this.rpc("question.resolve", { id: record.id, cancel: true });
      throw new Error("This permission requires a form that FaceClaw cannot safely display; use OpenClaw on the Mac");
    }
    const shown = JSON.stringify(record.questions);
    traceAssistantStage("question.present", record.questions.length);
    const answers = await this.options.onQuestion({ id: record.id, expiresAtMs: record.expiresAtMs,
      questions: record.questions.map(q => ({ ...q, options: q.options! })), signal: lifetime });
    if (!this.current(binding) || lifetime.aborted) return;
    const fresh = (await this.rpc("question.get", { id: record.id })).question as OpenClawQuestionRecord;
    if (!this.current(binding) || lifetime.aborted) return;
    if (JSON.stringify(fresh?.questions) !== shown) throw new Error("The permission request changed; it was not approved");
    if (answers === null) { await this.rpc("question.resolve", { id: record.id, cancel: true }); return; }
    const resolution = buildQuestionResolution(fresh, record, answers, Date.now());
    await this.rpc("question.resolve", resolution);
  }

  private async answerPlugin(record: PluginApproval, binding: Binding, lifetime: PromptLifetime): Promise<void> {
    // Only a complete host-provided send preview may offer an Allow button.
    let preview: any;
    try { preview = JSON.parse(record.request.detail ?? ""); } catch { /* unsupported preview */ }
    const canAllow = record.request.pluginId === "codex" && record.request.toolName === "codex_mcp_tool_approval" &&
      record.request.mcpTool?.server === "messages" && record.request.mcpTool?.tool === "send_message" &&
      typeof record.request.toolCallId === "string" && record.request.toolCallId.length > 0 && preview?.toolCallId === record.request.toolCallId &&
      typeof preview.argumentsSha256 === "string" && /^[a-f0-9]{64}$/.test(preview.argumentsSha256) &&
      preview?.kind === "faceclaw-message-send-v1" && typeof preview.recipient === "string" && preview.recipient.length > 0 &&
      typeof preview.text === "string" && preview.text.length > 0 && record.request.allowedDecisions?.includes("allow-once");
    const choices = canAllow ? [{ label: "Cancel", value: "deny" }, { label: "Send once", value: "allow-once" }] : [{ label: "Decline", value: "deny" }];
    const text = canAllow ? `To: ${preview.recipient}\n\n${preview.text}`
      : `${record.request.title}\n${record.request.description}\n\nFull action details are unavailable. Review this request on your Mac.`;
    const snapshot = JSON.stringify(record.request);
    const answers = await this.options.onQuestion({ id: record.id, expiresAtMs: record.expiresAtMs, signal: lifetime,
      questions: [{ questionId: "decision", header: canAllow ? "Send message?" : "Permission unavailable", question: text, options: choices }] });
    if (!this.current(binding) || lifetime.aborted) return;
    const list: PluginApproval[] = await this.rpc("plugin.approval.list", {});
    const fresh = list.filter(a => a.id === record.id);
    if (!this.current(binding) || lifetime.aborted) return;
    if (fresh.length !== 1 || JSON.stringify(fresh[0]!.request) !== snapshot || fresh[0]!.expiresAtMs <= Date.now()) throw new Error("The send confirmation changed or expired; it was not approved");
    const indexes = answers?.decision;
    if (answers !== null && (!indexes || indexes.length !== 1 || !Number.isInteger(indexes[0]) || !choices[indexes[0]!])) throw new Error("Invalid send confirmation");
    await this.rpc("plugin.approval.resolve", { id: record.id, decision: indexes ? choices[indexes[0]!]!.value : "deny" });
  }
}
