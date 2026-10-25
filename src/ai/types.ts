// Types the AI layers share: what the tactical layer reports upward and what the LLM's answers
// are kept as (both read by the LLM's report, the panels and the match log).

// What Jev reports upward about one hero (R5: lower layers report to the commander).
export interface JevAssessment {
  recentDecisions: string[];
  surrounded?: number; // 0–1
  threat?: number; // 0–3
  orderStillFits?: number; // 0–1
}

export type Stance = 'aggressive' | 'defensive' | 'regroup';

export interface LlmDecision {
  time: number; // simulation time when the request was sent
  model: string; // the model that answered
  latencyMs: number;
  situation: string;
  change: string;
  stance: Stance | '';
  plan: string;
  orders: string[]; // orders that were valid and applied, e.g. "hero 1: move D4-NE"
  rejected: string[]; // orders that could not be used, with the reason
  raw: string;
  usage: LlmUsage | null; // cost and tokens of this answer, as the dev server reports them
}

// What one answer cost (Q11). Estimates from the Agent SDK, not a bill.
export interface LlmUsage {
  costUsd: number | null;
  inputTokens: number | null; // not counting cached input
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  apiMs: number | null; // time in API calls, part of latencyMs
  modelIds: string[]; // the full model ids behind the menu's alias
}
