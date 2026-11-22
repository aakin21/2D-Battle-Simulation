import type { query, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeModel } from '../src/ai/Models';
import {
  LlmError,
  num,
  sessionClosed,
  type Answer,
  type AnswerMeta,
  type LlmSession,
} from './llmSession';

// Each alias runs a pinned model of one generation (D44). The CLI's own aliases are not used:
// its "haiku" ran Haiku 4.5, an older generation than Sonnet and Opus 5.5, and much slower here
// (35–70 s per answer against 4–12 s for Opus), and an alias can change without notice.
const MODEL_IDS: Record<ClaudeModel, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
};

const LASTING = [
  /hit your .*limit/i, // "You've hit your session limit · resets 3:45pm", weekly, Opus, spend
  /spend limit|credits? required|budget/i,
  /\b40[13]\b|authenticat|not logged in|login expired|invalid api key|\/login/i,
];

function lastingError(text: string): boolean {
  return LASTING.some((re) => re.test(text));
}

// The Agent SDK's query(), passed in by whoever loaded the SDK: the dev server imports it
// (llmPlugin.ts); the AI bridge loads it when it starts, and runs without it (bridge.ts)
export type QueryFn = typeof query;

// A long-lived Agent SDK session. Messages are pushed into an async queue that the SDK
// reads from; each reply arrives as a "result" message.
export class ClaudeSession implements LlmSession {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private ended = false; // the SDK stream finished or failed: no answer will come any more
  private waiting: Array<{ resolve: (answer: Answer) => void; reject: (err: Error) => void }> = [];
  private costSoFar = 0;
  private apiMsSoFar = 0;
  private q: Query;

  constructor(
    query: QueryFn,
    readonly matchId: string,
    readonly model: ClaudeModel,
    systemPrompt: string,
    maxBudgetUsd: number,
    private readonly side = ''
  ) {
    this.q = query({
      prompt: this.input(),
      options: {
        model: MODEL_IDS[model],
        systemPrompt,
        tools: [],
        settingSources: [],
        persistSession: false,
        maxBudgetUsd,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      },
    });
    void this.readLoop();
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  private async readLoop(): Promise<void> {
    let reason = new Error('the LLM session ended');
    try {
      for await (const message of this.q) {
        // Diagnostics in the dev server's output: the model that actually runs (the menu gives an
        // alias) and every retry the Claude CLI makes on its own, which otherwise only shows as
        // a slow answer (it waits and retries up to 10 times on overload or rate limits)
        if (message.type === 'system' && message.subtype === 'init')
          console.warn(
            `[llm] ${this.side} session started: ${this.model} (${MODEL_IDS[this.model]}) → ${message.model}`
          );
        if (message.type === 'system' && message.subtype === 'api_retry')
          console.warn(
            `[llm] ${this.side} (${this.model}) retry ${message.attempt}/${message.max_retries} in ${Math.round(message.retry_delay_ms / 1000)} s: status ${message.error_status ?? 'none'}, ${String(message.error)}${message.no_response ? `, no response after ${Math.round(message.no_response.waited_ms / 1000)} s` : ''}`
          );
        if (message.type !== 'result') continue;
        const pending = this.waiting.shift();
        const meta = this.meta(message);
        if (!pending) continue;
        if (message.subtype === 'success' && !message.is_error) {
          pending.resolve({ text: message.result, meta });
          continue;
        }
        // An API error (after the CLI's own retries) ends the turn as "success" with is_error and
        // the error text as the result; it must not reach the browser as the model's reply
        const text =
          message.subtype === 'success'
            ? message.result || 'LLM API error'
            : [`LLM error: ${message.subtype}`, ...(message.errors ?? [])].join('; ');
        const lasting = message.subtype === 'error_max_budget_usd' || lastingError(text);
        pending.reject(new LlmError(text, !lasting, true));
      }
    } catch (err) {
      reason = err as Error;
    }
    // Requests still waiting would otherwise hang until the answer timeout
    this.ended = true;
    for (const p of this.waiting.splice(0)) p.reject(reason);
  }

  private meta(message: {
    total_cost_usd?: unknown;
    usage?: Record<string, unknown>;
    duration_api_ms?: unknown;
    num_turns?: unknown;
    modelUsage?: Record<string, unknown>;
  }): AnswerMeta {
    // A running total; an error result may carry zeroes, which must not reset it
    const total = num(message.total_cost_usd);
    const costUsd = total === null || total < this.costSoFar ? null : total - this.costSoFar;
    if (total !== null && total > this.costSoFar) this.costSoFar = total;
    const usage = message.usage ?? {};
    return {
      costUsd,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      apiMs: this.apiDelta(num(message.duration_api_ms)),
      turns: num(message.num_turns),
      modelIds: Object.keys(message.modelUsage ?? {}),
    };
  }

  // duration_api_ms is the session's running total; one answer's share is the difference
  private apiDelta(total: number | null): number | null {
    if (total === null || total < this.apiMsSoFar) return null;
    const delta = total - this.apiMsSoFar;
    this.apiMsSoFar = total;
    return delta;
  }

  // A session that can still answer; otherwise the next request opens a new one
  isAlive(): boolean {
    return !this.closed && !this.ended;
  }

  ask(prompt: string): Promise<Answer> {
    return new Promise((resolve, reject) => {
      if (!this.isAlive()) return reject(new LlmError('the LLM session ended', true));
      this.waiting.push({ resolve, reject });
      this.queue.push({
        type: 'user',
        message: { role: 'user', content: prompt },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      this.wake?.();
      this.wake = null;
    });
  }

  // Replaced by a new match or model, or failed: requests still waiting get an error now
  close(): void {
    this.closed = true;
    this.wake?.();
    this.q.close();
    for (const p of this.waiting.splice(0)) p.reject(sessionClosed());
  }
}
