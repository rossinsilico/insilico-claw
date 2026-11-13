/**
 * Shared assistant types. Kept backend-agnostic so the UI (AssistantLayer)
 * talks to the same session surface whether the turn runs on the phone
 * (direct provider loop) or against the user's own agent (external bridge,
 * later phases).
 */

/** Situational grounding injected per turn (system prompt in direct mode). */
export type AssistantContext = {
  /** Foreground app id, or null when the sidebar/launcher is all that's up. */
  foregroundApp: string | null;
  foregroundTitle: string | null;
  screenOn: boolean;
  /** Human-readable local time, e.g. "Thu Jul 24, 3:15 PM". */
  localTime: string;
  /** Headset battery percent (0..100), or null if unknown. */
  headsetBattery: number | null;
};

export type AssistantQuestionOption = {
  label: string;
  value?: string;
  description?: string;
};

export type AssistantQuestion = {
  questionId: string;
  header?: string;
  question: string;
  options: AssistantQuestionOption[];
  multiSelect?: boolean;
  allowEmpty?: boolean;
};

/** The AbortSignal surface used here, kept structural for non-DOM builds. */
export type AssistantQuestionSignal = {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
};

export type AssistantQuestionPrompt = {
  id: string;
  expiresAtMs: number;
  questions: AssistantQuestion[];
  signal: AssistantQuestionSignal;
};

export type AssistantTurnCallbacks = {
  /** Streamed reply text (delta plus the full text so far). */
  onTextDelta: (delta: string, textSoFar: string) => void;
  /** A tool is being invoked; label is display-ready, e.g. "calendar.list_events". */
  onToolActivity: (label: string) => void;
  /** Ask the wearer for explicit choices; null leaves the operation unanswered. */
  onQuestion?: (prompt: AssistantQuestionPrompt) => Promise<Record<string, number[]> | null>;
  onTurnDone: (result: { stopReason: string | null }) => void;
  onError: (message: string) => void;
};

/** A handle to an in-flight turn. */
export type AssistantTurnHandle = {
  cancel(): void;
};

/** Connection settings for the external agent bridge (assistant.bridge* settings). */
export type AssistantBridgeConfig = {
  host: string;
  port: number;
  token: string;
};
