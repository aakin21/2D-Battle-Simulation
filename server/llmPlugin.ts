import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Layer 3 (D10): the strategic LLM runs in the dev server through the Claude Agent SDK,
// using the developer's own Claude login. One persistent session per side, so a decision
// takes ~1–2 s instead of ~8 s (R2), and the LLM remembers earlier decisions within a match
// (in-match memory, D11). A new match id starts a fresh session.
//
// POST /api/llm  { side, matchId, system, prompt }  →  { text, latencyMs, model }

// The system prompt (rulebook) is built in the browser from the engine's own constants
// (src/ai/GameRules.ts) and sent with each request; it is used when a session starts.

// Model chosen per side in the menu (D29). Only these aliases are accepted.
const MODELS = ['haiku', 'sonnet', 'opus'] as const;
type Model = (typeof MODELS)[number];
const DEFAULT_MODEL: Model = (MODELS as readonly string[]).includes(process.env.LLM_MODEL ?? '')
  ? (process.env.LLM_MODEL as Model)
  : 'sonnet';

// A session's estimated spend (the SDK's total_cost_usd) above which it stops answering, so a
// runaway session cannot spend without limit. A match makes ~25 requests per side.
const MAX_BUDGET_USD = Number(process.env.LLM_MAX_BUDGET_USD) || 5;

// What one answer cost and how long the model took, from the SDK's result message, for the
// cost and latency metrics of the experiments (Q11). Estimates, not a bill.
interface AnswerMeta {
  costUsd: number | null; // this answer only (the SDK reports a running total per session)
  inputTokens: number | null; // not counting cached input
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  apiMs: number | null; // time spent in API calls
  turns: number | null;
  modelIds: string[]; // the full model ids that answered (the menu gives an alias)
}

interface Answer {
  text: string;
  meta: AnswerMeta;
}

// retryable: the next request may well work (overloaded, rate limited, connection lost, a session
// that ended or timed out). Plan or budget limits and login problems stay until someone acts.
// fromResult: reported by the SDK in a result message; the session itself still works.
class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly fromResult = false
  ) {
    super(message);
  }
}

const LASTING = [
  /hit your .*limit/i, // "You've hit your session limit · resets 3:45pm", weekly, Opus, spend
  /spend limit|credits? required|budget/i,
  /\b40[13]\b|authenticat|not logged in|login expired|invalid api key|\/login/i,
];

function lastingError(text: string): boolean {
  return LASTING.some((re) => re.test(text));
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A long-lived Agent SDK session. Messages are pushed into an async queue that the SDK
// reads from; each reply arrives as a "result" message.
class Session {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private ended = false; // the SDK stream finished or failed: no answer will come any more
  private waiting: Array<{ resolve: (answer: Answer) => void; reject: (err: Error) => void }> = [];
  private costSoFar = 0;
  private q: Query;

  constructor(
    readonly matchId: string,
    readonly model: Model,
    systemPrompt: string
  ) {
    this.q = query({
      prompt: this.input(),
      options: {
        model,
        systemPrompt,
        tools: [],
        settingSources: [],
        persistSession: false,
        maxBudgetUsd: MAX_BUDGET_USD,
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
      apiMs: num(message.duration_api_ms),
      turns: num(message.num_turns),
      modelIds: Object.keys(message.modelUsage ?? {}),
    };
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
    for (const p of this.waiting.splice(0))
      p.reject(new LlmError('the LLM session was closed', true));
  }
}

const sessions = new Map<string, Session>();

// Reached through the tunnel too (D37), so requests are bounded: a report is ~10 KB.
const MAX_BODY_BYTES = 1_000_000;
// Below the browser's 120 s, so the browser gets the reason and the stuck session is closed
// at once instead of after the browser has given up.
const ANSWER_TIMEOUT_MS = 110_000;
const SIDES = ['west', 'east'];

class TooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        reject(new TooLarge());
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
    // A client that goes away mid-body sends no 'end' (after 'end' this changes nothing)
    req.on('close', () => reject(new Error('the request was closed before its body ended')));
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function llmPlugin(): Plugin {
  return {
    name: 'battle-llm',
    configureServer(server) {
      server.middlewares.use('/api/llm', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        // Fields are checked below: a request can contain anything
        let body: {
          model?: unknown;
          side?: unknown;
          matchId?: unknown;
          system?: unknown;
          prompt?: unknown;
        };
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          if (err instanceof TooLarge) return send(res, 413, { error: 'request too large' });
          return send(res, 400, { error: 'body must be JSON' });
        }
        const { side, matchId, system, prompt, model: requested } = body ?? {};
        if (!isText(side) || !isText(matchId) || !isText(system) || !isText(prompt))
          return send(res, 400, { error: 'side, matchId, system and prompt must be text' });
        // One session per side; any other value would open extra Agent SDK sessions
        if (!SIDES.includes(side)) return send(res, 400, { error: 'side must be west or east' });
        try {
          let session = sessions.get(side);
          const model: Model = MODELS.find((m) => m === requested) ?? DEFAULT_MODEL;
          if (
            !session ||
            !session.isAlive() ||
            session.matchId !== matchId ||
            session.model !== model
          ) {
            session?.close();
            session = new Session(matchId, model, system);
            sessions.set(side, session);
          }

          const started = Date.now();
          let answer: Answer;
          try {
            answer = await withTimeout(session.ask(prompt), ANSWER_TIMEOUT_MS);
          } catch (err) {
            // A session that hangs or ended is closed; the next request starts a fresh one. An
            // error reported in a result (overloaded, rate limited) leaves the session working,
            // and closing it would lose the match's conversation (in-match memory, D11).
            if (!(err instanceof LlmError && err.fromResult)) {
              session.close();
              if (sessions.get(side) === session) sessions.delete(side);
            }
            throw err;
          }
          send(res, 200, {
            text: answer.text,
            latencyMs: Date.now() - started,
            model,
            ...answer.meta,
          });
        } catch (err) {
          // retryable tells the browser to try again at its next report instead of stopping
          send(res, 500, {
            error: err instanceof Error ? err.message : String(err),
            retryable: err instanceof LlmError ? err.retryable : true,
          });
        }
      });

      server.httpServer?.on('close', () => {
        for (const s of sessions.values()) s.close();
        sessions.clear();
      });
    },
  };
}
