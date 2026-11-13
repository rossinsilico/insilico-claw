import { File, knownFolders, path } from "@nativescript/core";

let lines: string[] | null = null;

/** Bounded connection stages only: never record keys, message text or raw frames. */
export function traceAssistantStage(stage: string, count?: number): void {
  if (!/^(sse|input|question)\.[a-z-]+$/.test(stage) ||
      (count !== undefined && (typeof count !== "number" || !Number.isFinite(count)))) return;
  try {
    const filename = path.join(knownFolders.documents().path, "assistant-connection.log");
    if (lines === null) lines = File.exists(filename) ? File.fromPath(filename).readTextSync().split("\n").filter(Boolean).slice(-199) : [];
    lines.push(`${new Date().toISOString()} ${stage}${count === undefined ? "" : ` ${count}`}`);
    lines = lines.slice(-200);
    File.fromPath(filename).writeTextSync(lines.join("\n") + "\n");
  } catch { /* Diagnostics must never interrupt the assistant. */ }
}
