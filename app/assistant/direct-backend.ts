import { streamAnthropicMessage } from "../native/anthropic";
import { streamHermesChat } from "../native/hermes";
import { streamLocalModel } from "../native/local-llm";
import { streamOpenAiResponse } from "../native/openai";
import { streamOpenAiCompatibleChat } from "../native/openai-chat";
import type {
  LlmContentBlock,
  LlmMessage,
  LlmStreamHandle,
  LlmStreamOptions,
  LlmToolDefinition,
} from "./llm-protocol";
import type { AssistantProvider } from "./models";
import { healthDestinationForModel } from "./health-destination";
import type { ToolCallSignal, ToolRegistry, ToolResult } from "./tool-registry";
import type { AssistantTurnCallbacks, AssistantTurnHandle } from "./types";
import type { OpenClawInputClient } from "./openclaw-input-client";

/**
 * The on-phone agent loop: stream a reply, and while the model asks for tools,
 * execute them through the registry and feed the results back until it stops.
 * History lives in the AssistantSession; this backend appends the assistant
 * and tool-result messages to the array it is handed.
 */

/** Safety caps so a tool-thrashing model can't loop or run forever. */
const MAX_ITERATIONS = 8;
/** The on-phone model is slower per step and unreliable on long tool chains. */
const MAX_ITERATIONS_LOCAL = 4;
const MAX_TURN_MS = 2 * 60 * 1000;
/**
 * Hermes runs whole multi-tool agent tasks in one request, and dropping the
 * stream interrupts the run on the server, so its cap is only a backstop. A
 * dead server is caught sooner: Hermes sends keepalives every 10s, and both
 * transports fail a stream that goes quiet for 180s.
 */
const MAX_TURN_MS_HERMES = 20 * 60 * 1000;
/** Agent-compatible servers may run multi-tool tasks; required input must fail fast server-side. */
const MAX_TURN_MS_AGENT = 20 * 60 * 1000;

function isOpenClawModel(model: string): boolean {
  return model === "openclaw" || model.startsWith("openclaw/");
}

export type DirectTurnOptions = {
  provider: AssistantProvider;
  apiKey: string;
  model: string;
  effort?: "low" | "medium" | "high";
  /** Hermes: the API root, and the server-side session this conversation maps to. */
  baseUrl?: string;
  /** Venice-only web search for this interactive turn. */
  webSearch?: boolean;
  sessionId?: string;
  system: string;
  /** Owned by the session; this loop appends assistant + tool_result messages. */
  messages: LlmMessage[];
  /**
   * Build the tool list for the next request. Called once per loop iteration so
   * the set reflects apps opening/closing and foreground changes mid-turn; it
   * also refreshes the session's api-name map that resolveToolName reads.
   */
  buildTools: () => LlmToolDefinition[];
  registry: ToolRegistry;
  /** Map an API tool name (as the model calls it) back to its registry name. */
  resolveToolName: (apiName: string) => string;
  /** Called after a tool succeeds and before its result enters the next request. */
  onToolResult?: (name: string, result: ToolResult) => void;
  callbacks: AssistantTurnCallbacks;
};

class TurnToolSignal implements ToolCallSignal {
  private readonly listeners = new Set<() => void>();
  aborted = false;

  addEventListener(type: "abort", listener: () => void): void {
    if (type !== "abort") return;
    if (this.aborted) listener();
    else this.listeners.add(listener);
  }

  removeEventListener(type: "abort", listener: () => void): void {
    if (type === "abort") this.listeners.delete(listener);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

export class DirectAssistantBackend {
  runTurn(options: DirectTurnOptions): AssistantTurnHandle {
    const startMs = Date.now();
    let cancelled = false;
    let streamHandle: LlmStreamHandle | null = null;
    let inputClient: OpenClawInputClient | null = null;
    let inputConnectionId: string | undefined;
    let priorText = "";
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const toolSignal = new TurnToolSignal();
    const healthDestination = healthDestinationForModel(options);
    const clearDeadline = () => { if (deadline !== null) clearTimeout(deadline); deadline = null; };

    const finishError = (message: string) => {
      if (cancelled) return;
      cancelled = true;
      toolSignal.abort();
      clearDeadline(); streamHandle?.cancel(); streamHandle = null;
      inputClient?.close();
      options.callbacks.onError(message);
    };

    const maxIterations = options.provider === "local" ? MAX_ITERATIONS_LOCAL : MAX_ITERATIONS;
    const maxTurnMs = options.provider === "hermes" ? MAX_TURN_MS_HERMES
      : options.provider === "openai-compatible" && isOpenClawModel(options.model)
        ? MAX_TURN_MS_AGENT : MAX_TURN_MS;
    const runIteration = (iteration: number): void => {
      if (cancelled) return;
      if (iteration >= maxIterations) {
        finishError("Assistant stopped: too many tool steps");
        return;
      }
      if (Date.now() - startMs > maxTurnMs) {
        finishError("Assistant stopped: turn took too long");
        return;
      }

      const streamOptions: LlmStreamOptions & { webSearch?: boolean } = {
        apiKey: options.apiKey,
        model: options.model,
        system: options.system,
        effort: options.effort,
        webSearch: options.webSearch,
        messages: options.messages,
        // Hermes runs its own tools; Faceclaw's are not offered to it.
        tools: options.provider === "hermes" ? [] : options.buildTools(),
        onTextDelta: (delta, textSoFar) => {
          if (cancelled) return;
          options.callbacks.onTextDelta(delta, priorText + textSoFar);
        },
        onDone: (result) => {
          streamHandle = null;
          inputClient?.endRun();
          if (cancelled) return;
          if (result.stopReason === "refusal") {
            finishError("The assistant declined this request");
            return;
          }
          const fullText = priorText + result.text;
          options.callbacks.onTextDelta("", fullText);
          priorText = fullText ? `${fullText}\n\n` : "";
          // Record what the model produced this iteration.
          const assistantContent: LlmContentBlock[] = result.content.length
            ? result.content
            : [{ type: "text", text: result.text }];
          options.messages.push({ role: "assistant", content: assistantContent });

          const toolUses = assistantContent.filter(
            (block): block is Extract<LlmContentBlock, { type: "tool_use" }> =>
              block.type === "tool_use",
          );
          if (result.stopReason !== "tool_use" || toolUses.length === 0) {
            clearDeadline();
            inputClient?.close();
            options.callbacks.onTurnDone({ stopReason: result.stopReason });
            return;
          }
          void this.runToolCalls(toolUses, options, () => cancelled, toolSignal, healthDestination)
            .then((toolResults) => {
              // Always record the results, even if cancelled mid-flight: an
              // assistant tool_use with no matching tool_result would make the
              // next turn's request invalid. Only the loop continuation is gated.
              options.messages.push({ role: "user", content: toolResults });
              if (cancelled) return;
              runIteration(iteration + 1);
            })
            .catch((error) => {
              finishError(`Tool execution failed: ${String((error as Error)?.message ?? error)}`);
            });
        },
        onError: (message) => {
          streamHandle = null;
          finishError(message);
        },
      };
      streamHandle =
        options.provider === "hermes"
          ? streamHermesChat({ ...streamOptions, baseUrl: options.baseUrl ?? "", sessionId: options.sessionId ?? "" })
          : options.provider === "openai-compatible"
          ? streamOpenAiCompatibleChat({ ...streamOptions, baseUrl: options.baseUrl ?? "", user: options.sessionId,
              inputConnectionId, onOpenClawRun: (runId, sessionKey, connId) => inputClient?.bindRun(runId, sessionKey, connId) })
          : options.provider === "openai"
          ? streamOpenAiResponse(streamOptions)
          : options.provider === "local"
            ? streamLocalModel(streamOptions)
            : streamAnthropicMessage(streamOptions);
    };

    deadline = setTimeout(() => finishError("Assistant stopped: turn took too long"), maxTurnMs);
    if (typeof global !== "undefined" && global.isIOS && options.provider === "openai-compatible" && isOpenClawModel(options.model) && options.callbacks.onQuestion) {
      void import("./openclaw-input-client").then(async ({ OpenClawInputClient }) => {
        if (cancelled) return;
        inputClient = new OpenClawInputClient({ baseUrl: options.baseUrl ?? "", apiKey: options.apiKey,
          onQuestion: options.callbacks.onQuestion!, onError: finishError });
        inputConnectionId = await inputClient.connect();
        if (!cancelled) runIteration(0);
      }).catch(error => finishError(String((error as Error).message)));
    } else runIteration(0);

    return {
      cancel: () => {
        cancelled = true;
        toolSignal.abort();
        clearDeadline();
        streamHandle?.cancel();
        streamHandle = null;
        inputClient?.close();
      },
    };
  }

  private async runToolCalls(
    toolUses: Array<Extract<LlmContentBlock, { type: "tool_use" }>>,
    options: DirectTurnOptions,
    isCancelled: () => boolean,
    signal: ToolCallSignal,
    healthDestination: string | null,
  ): Promise<LlmContentBlock[]> {
    const results: LlmContentBlock[] = [];
    for (const toolUse of toolUses) {
      if (isCancelled()) {
        results.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Cancelled", is_error: true });
        continue;
      }
      const canonicalName = options.resolveToolName(toolUse.name);
      options.callbacks.onToolActivity(canonicalName);
      const result = await options.registry.callTool(canonicalName, toolUse.input, {
        healthDestination: healthDestination ?? undefined,
        signal,
      });
      if (result.ok) options.onToolResult?.(canonicalName, result);
      const content = result.ok ? result.content ?? "" : result.error ?? "Tool error";
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content,
        is_error: !result.ok,
      });
    }
    return results;
  }
}
