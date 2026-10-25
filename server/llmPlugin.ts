import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_MODELS, isLlmModel, openRouterId, type ClaudeModel } from '../src/ai/Models';
import { LLM_SERVER_TIMEOUT_MS } from '../src/ai/Limits';

// Layer 3 (D10): the strategic LLM runs in the dev server through the Claude Agent SDK,
// using the developer's own Claude login. One persistent session per side, so a decision
// takes ~1–2 s instead of ~8 s (R2), and the LLM remembers earlier decisions within a match
// (in-match memory, D11). A new match id starts a fresh session.
//
// POST /api/llm  { side, matchId, system, prompt, model }  →  { text, latencyMs, model }
//
// D52: a model "openrouter:<id>" runs that OpenRouter model instead (OPENROUTER_API_KEY), for
// the comparison of LLMs of different companies. Its session keeps the match's conversation
// here and sends it with every request, as OpenRouter's API keeps none.

// The system prompt (rulebook) is built in the browser from the engine's own constants
// (src/ai/GameRules.ts) and sent with each request; it is used when a session starts.

// Claude model chosen per side in the menu (D29). Only these aliases are accepted.
type Model = ClaudeModel;

// Each alias runs a pinned model of one generation (D44). The CLI's own aliases are not used:
// its "haiku" ran Haiku 4.5, an older generation than Sonnet and Opus 5.5, and much slower here
// (35–70 s per answer against 4–12 s for Opus), and an alias can change without notice.
const MODEL_IDS: Record<Model, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
};
// The model of a request that names none: LLM_MODEL from .env.local or the shell (read in
// llmPlugin, from the env vite.config.ts loads)
function defaultModel(value: string | undefined): Model {
  return (CLAUDE_MODELS as readonly string[]).includes(value ?? '') ? (value as Model) : 'sonnet';
}

// A session's estimated spend (the SDK's total_cost_usd) above which it stops answering, so a
// runaway session cannot spend without limit. A match makes ~33 requests per side (every 15 s,
// D50). LLM_MAX_BUDGET_USD from .env.local or the shell, 5 by default.
function maxBudget(value: string | undefined): number {
  return Number(value) || 5;
}

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

const SESSION_CLOSED = 'the LLM session was closed';

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

// A fresh error each time, so its stack trace shows where the closed session was noticed
function sessionClosed(): LlmError {
  return new LlmError(SESSION_CLOSED, true);
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

// What the endpoint needs from a session, whichever service answers
interface LlmSession {
  readonly matchId: string;
  readonly model: string;
  isAlive(): boolean;
  ask(prompt: string): Promise<Answer>;
  close(): void;
}

// A long-lived Agent SDK session. Messages are pushed into an async queue that the SDK
// reads from; each reply arrives as a "result" message.
class Session implements LlmSession {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private ended = false; // the SDK stream finished or failed: no answer will come any more
  private waiting: Array<{ resolve: (answer: Answer) => void; reject: (err: Error) => void }> = [];
  private costSoFar = 0;
  private apiMsSoFar = 0;
  private q: Query;

  constructor(
    readonly matchId: string,
    readonly model: Model,
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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// An OpenRouter model (D52). The API keeps no conversation, so the session keeps the match's
// messages and sends all of them with every request (the Agent SDK session keeps them on its
// side); one request at a time, like the SDK session.
class OpenRouterSession implements LlmSession {
  private messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private costSoFar = 0;
  private abort = new AbortController();

  constructor(
    readonly matchId: string,
    readonly model: string, // "openrouter:<id>"
    private readonly id: string,
    systemPrompt: string,
    private readonly key: string,
    private readonly maxBudgetUsd: number,
    private readonly side = ''
  ) {
    this.messages = [{ role: 'system', content: systemPrompt }];
    console.warn(`[llm] ${side} session started: ${id} (OpenRouter)`);
  }

  isAlive(): boolean {
    return !this.closed;
  }

  ask(prompt: string): Promise<Answer> {
    const answer = this.queue.then(() => this.send(prompt));
    this.queue = answer.catch(() => undefined);
    return answer;
  }

  private async send(prompt: string): Promise<Answer> {
    if (this.closed) throw sessionClosed();
    if (this.costSoFar >= this.maxBudgetUsd)
      throw new LlmError(
        `this session spent its budget of $${this.maxBudgetUsd} (LLM_MAX_BUDGET_USD)`,
        false,
        true
      );
    const messages = [...this.messages, { role: 'user' as const, content: prompt }];
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: this.abort.signal,
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://aakin21.github.io/2D-Battle-Simulation/',
          'X-Title': '2D Battle Simulation',
        },
        body: JSON.stringify({ model: this.id, messages, usage: { include: true } }),
      });
    } catch (err) {
      // A lost connection keeps the conversation: the next report tries again
      throw new LlmError(
        this.closed
          ? SESSION_CLOSED
          : `OpenRouter could not be reached: ${err instanceof Error ? err.message : String(err)}`,
        true,
        true
      );
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: unknown };
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: Record<string, unknown> & { prompt_tokens_details?: Record<string, unknown> };
    } | null;
    const detail = typeof body?.error?.message === 'string' ? body.error.message : '';
    if (!res.ok) {
      // A wrong key, no credits, a model that does not exist: nothing changes until someone acts
      const lasting = [400, 401, 402, 403, 404].includes(res.status);
      const hint =
        res.status === 401
          ? ' Set OPENROUTER_API_KEY in .env.local and restart the dev server.'
          : '';
      throw new LlmError(
        `OpenRouter: ${detail || `HTTP ${res.status}`} (HTTP ${res.status}).${hint}`,
        !lasting,
        true
      );
    }
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string')
      throw new LlmError(
        `OpenRouter: the answer had no text${detail ? ` (${detail})` : ''}`,
        true,
        true
      );
    this.messages = [...messages, { role: 'assistant', content: text }];
    const usage = body?.usage ?? {};
    const costUsd = num(usage.cost);
    if (costUsd !== null) this.costSoFar += costUsd;
    return {
      text,
      meta: {
        costUsd,
        inputTokens: num(usage.prompt_tokens), // cached input included, unlike the SDK's count
        outputTokens: num(usage.completion_tokens),
        cacheReadTokens: num(usage.prompt_tokens_details?.cached_tokens),
        cacheWriteTokens: null,
        apiMs: Date.now() - started,
        turns: 1,
        modelIds: [typeof body?.model === 'string' ? body.model : this.id],
      },
    };
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
  }
}

const sessions = new Map<string, LlmSession>();

// Reached through the tunnel too (D37), so requests are bounded: a request is ~20 KB, half of it
// the rulebook, half the report. A body that has not fully come within BODY_TIMEOUT_MS is
// refused too, so a client that stops sending cannot hold a request open.
const MAX_BODY_BYTES = 1_000_000;
const BODY_TIMEOUT_MS = 30_000;
const SIDES = ['west', 'east'];

class TooLarge extends Error {}
class TooSlow extends Error {}

// The body as UTF-8 text, decoded once it is whole (a character can be split between chunks)
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // A body the client says is too large is refused before it is read
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return reject(new TooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(Buffer.concat(chunks, size).toString('utf8'));
    };
    const timer = setTimeout(() => finish(new TooSlow()), BODY_TIMEOUT_MS);
    req.on('data', (data: Buffer | string) => {
      if (done) return; // the rest of a refused body is read and dropped
      const chunk = typeof data === 'string' ? Buffer.from(data) : data; // text once decoded
      size += chunk.length;
      if (size > MAX_BODY_BYTES) finish(new TooLarge());
      else chunks.push(chunk);
    });
    req.on('end', () => finish(null));
    req.on('error', (err) => finish(err));
    // A client that goes away mid-body sends no 'end' (after 'end' this changes nothing)
    req.on('close', () => finish(new Error('the request was closed before its body ended')));
  });
}

// A refusal sent before the whole body was read. Node closes the connection as soon as the
// answer is sent, and closing it while the client still sends resets it, which can lose the
// answer; so the rest of the body is read and dropped first, and the answer goes out when it has
// ended, or after REFUSED_BODY_MS for a client that keeps sending or has stopped
const REFUSED_BODY_MS = 1000;

function refuseBody(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  error: string
): void {
  let sent = false;
  const answer = () => {
    if (sent) return;
    sent = true;
    clearTimeout(timer);
    res.setHeader('Connection', 'close');
    send(res, status, { error });
  };
  const timer = setTimeout(answer, REFUSED_BODY_MS);
  if (req.complete || req.readableEnded) return answer();
  req.on('end', answer);
  req.on('close', answer);
  req.resume();
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

export function llmPlugin(env: Record<string, string> = {}): Plugin {
  const openRouterKey = env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '';
  const DEFAULT_MODEL = defaultModel(env.LLM_MODEL ?? process.env.LLM_MODEL);
  const MAX_BUDGET_USD = maxBudget(env.LLM_MAX_BUDGET_USD ?? process.env.LLM_MAX_BUDGET_USD);
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
          if (err instanceof TooLarge) return refuseBody(req, res, 413, 'request too large');
          if (err instanceof TooSlow)
            return refuseBody(
              req,
              res,
              408,
              `the body did not come within ${BODY_TIMEOUT_MS / 1000} s`
            );
          return send(res, 400, { error: 'body must be JSON' });
        }
        const { side, matchId, system, prompt, model: requested } = body ?? {};
        if (!isText(side) || !isText(matchId) || !isText(system) || !isText(prompt))
          return send(res, 400, { error: 'side, matchId, system and prompt must be text' });
        // One session per side; any other value would open extra Agent SDK sessions
        if (!SIDES.includes(side)) return send(res, 400, { error: 'side must be west or east' });
        try {
          let session = sessions.get(side);
          // A Claude alias or "openrouter:<id>" (D52); a request without a model gets the
          // default, and an unknown one is refused so a typo never runs another model
          if (requested !== undefined && typeof requested !== 'string')
            return send(res, 400, { error: 'model must be text' });
          const model: string = requested ?? DEFAULT_MODEL;
          const routerId = openRouterId(model);
          if (!isLlmModel(model))
            return send(res, 400, { error: `unknown model ${model.slice(0, 80)}` });
          if (routerId !== null && !openRouterKey)
            return send(res, 500, {
              error: 'Set OPENROUTER_API_KEY in .env.local and restart the dev server.',
              retryable: false,
            });
          if (
            !session ||
            !session.isAlive() ||
            session.matchId !== matchId ||
            session.model !== model
          ) {
            session?.close();
            session =
              routerId !== null
                ? new OpenRouterSession(
                    matchId,
                    model,
                    routerId,
                    system,
                    openRouterKey,
                    MAX_BUDGET_USD,
                    side
                  )
                : new Session(matchId, model as Model, system, MAX_BUDGET_USD, side);
            sessions.set(side, session);
          }

          const started = Date.now();
          let answer: Answer;
          try {
            answer = await withTimeout(session.ask(prompt), LLM_SERVER_TIMEOUT_MS);
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
          console.warn(
            `[llm] ${side} (${model}): answered in ${((Date.now() - started) / 1000).toFixed(1)} s (API ${answer.meta.apiMs === null ? '?' : (answer.meta.apiMs / 1000).toFixed(1)} s)`
          );
          send(res, 200, {
            text: answer.text,
            latencyMs: Date.now() - started,
            model,
            ...answer.meta,
          });
        } catch (err) {
          // Also logged in the dev server's terminal, so a failure can be read where it happened
          console.warn(
            `[llm] ${side} (${String(requested ?? DEFAULT_MODEL)}): ${err instanceof Error ? err.message : String(err)}`
          );
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
