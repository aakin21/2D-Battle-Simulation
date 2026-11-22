// What every LLM session shares, the Agent SDK's (claudeSession.ts) and a chat API's
// (chatSession.ts), and what the endpoint (llmPlugin.ts) needs from them.

// What one answer cost and how long the model took, from the SDK's result message or the chat
// API's answer, for the cost and latency metrics of the experiments (Q11). Estimates, not a bill.
export interface AnswerMeta {
  // This answer only (the SDK reports a running total per session, a chat API the answer's own
  // usage.cost); null when the service reports none (a local server usually)
  costUsd: number | null;
  inputTokens: number | null; // not counting cached input
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  apiMs: number | null; // time spent in API calls
  turns: number | null;
  modelIds: string[]; // the full model ids that answered (the menu gives an alias)
}

export interface Answer {
  text: string;
  meta: AnswerMeta;
}

export const SESSION_CLOSED = 'the LLM session was closed';

// retryable: the next request may well work (overloaded, rate limited, connection lost, a session
// that ended or timed out). Plan or budget limits and login problems stay until someone acts.
// fromResult: reported by the SDK in a result message; the session itself still works.
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly fromResult = false
  ) {
    super(message);
  }
}

// A fresh error each time, so its stack trace shows where the closed session was noticed
export function sessionClosed(): LlmError {
  return new LlmError(SESSION_CLOSED, true);
}

export const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

// What the endpoint needs from a session, whichever service answers
export interface LlmSession {
  readonly matchId: string;
  readonly model: string;
  isAlive(): boolean;
  ask(prompt: string): Promise<Answer>;
  close(): void;
}

export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
