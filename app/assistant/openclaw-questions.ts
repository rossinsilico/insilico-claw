/** Pure validation shared by the OpenClaw Gateway question sideband and its UI. */

export type OpenClawQuestionOption = { label: string; value?: string; description?: string };
export type OpenClawQuestion = {
  questionId: string;
  header?: string;
  question: string;
  options?: OpenClawQuestionOption[];
  multiSelect?: boolean;
  allowEmpty?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  resource?: unknown;
};
export type OpenClawQuestionRecord = {
  id: string;
  sessionKey: string;
  runId: string;
  status: string;
  createdAtMs: number;
  expiresAtMs: number;
  questions: OpenClawQuestion[];
};
export type OpenClawQuestionBinding = Pick<OpenClawQuestionRecord, "id" | "sessionKey" | "runId">;

export function gatewayQuestionScopes(includeExecutionApprovals = false): string[] {
  return ["operator.read", "operator.questions", ...(includeExecutionApprovals ? ["operator.approvals"] : [])];
}

export function selectPendingQuestion(
  records: OpenClawQuestionRecord[],
  sessionKey: string,
  runId: string,
  nowMs: number,
): OpenClawQuestionRecord | null {
  const matches = records.filter((record) =>
    record.sessionKey === sessionKey && record.runId === runId &&
    record.status === "pending" && record.expiresAtMs > nowMs,
  );
  return matches.length === 1 ? matches[0]! : null;
}

/** Build question.resolve only from a freshly fetched, exactly bound pending record. */
export function buildQuestionResolution(
  record: OpenClawQuestionRecord,
  binding: OpenClawQuestionBinding,
  selectedOptionIndexes: Record<string, number[]>,
  nowMs: number,
): { id: string; answers: { answers: Record<string, string[]> } } {
  if (record.id !== binding.id || record.sessionKey !== binding.sessionKey || record.runId !== binding.runId) {
    throw new Error("Question binding changed; refresh before answering");
  }
  if (record.status !== "pending" || record.expiresAtMs <= nowMs) {
    throw new Error("Question is no longer pending");
  }

  const answers: Record<string, string[]> = {};
  for (const question of record.questions) {
    // Core questions allow optional free text; this client only submits listed choices.
    if (question.isSecret || question.resource !== undefined) {
      throw new Error(`Question ${question.questionId} cannot be answered safely by this client`);
    }
    const options = question.options ?? [];
    if (!options.length) {
      throw new Error(`Question ${question.questionId} cannot be answered safely by this client`);
    }
    const indexes = selectedOptionIndexes[question.questionId] ?? [];
    if (!indexes.length) {
      if (!question.allowEmpty) throw new Error(`Question ${question.questionId} requires an answer`);
      answers[question.questionId] = [];
      continue;
    }
    if (!question.multiSelect && indexes.length !== 1) {
      throw new Error(`Question ${question.questionId} accepts one answer`);
    }
    const values: string[] = [];
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0 || index >= options.length) {
        throw new Error(`Question ${question.questionId} requires a valid option`);
      }
      const option = options[index]!;
      const value = typeof option.value === "string" && option.value ? option.value : option.label;
      if (!value || values.includes(value)) throw new Error(`Question ${question.questionId} requires a valid option`);
      values.push(value);
    }
    answers[question.questionId] = values;
  }
  return { id: record.id, answers: { answers } };
}
