import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  CLAUDE_MODELS,
  isLlmModel,
  localModelId,
  openRouterId,
  type ClaudeModel,
} from '../src/ai/Models';
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
//
// A model "local:<name>" runs on the user's own computer (Ollama, LM Studio, llama.cpp) or any
// other OpenAI-compatible chat API, at LOCAL_LLM_URL. Paid APIs cost too much for every player
// to run the LLM; a local model costs nothing, if it answers within the 15 s interval.

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

// A session's estimated spend (the SDK's total_cost_usd, or the sum of a chat API's usage.cost)
// above which it stops answering, so a runaway session cannot spend without limit. A match makes
// ~33 requests per side (every 15 s, D50). LLM_MAX_BUDGET_USD from .env.local or the shell, 5 by
// default.
function maxBudget(value: string | undefined): number {
  return Number(value) || 5;
}

// What one answer cost and how long the model took, from the SDK's result message or the chat
// API's answer, for the cost and latency metrics of the experiments (Q11). Estimates, not a bill.
interface AnswerMeta {
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

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// The most of a service's own error text that goes into a message and the log: a server may send
// megabytes of it
const MAX_DETAIL = 300;
const capped = (text: string): string =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;

// An OpenAI-compatible chat API that runs one model: OpenRouter (D52), or a local model's server.
// What differs between them is set here; the session that talks to them is the same.
interface ChatApi {
  id: string; // the service's name for the model
  service: string; // names it in errors: "OpenRouter", "Local LLM"
  started: string; // in the session's first log line
  url: string; // always from the server's own settings, never from a request
  key: string; // sent as a Bearer token when set; printable ASCII only (keyProblem)
  headers: Record<string, string>; // sent besides Authorization and Content-Type
  body: Record<string, unknown>; // sent besides the model and the messages
  historyTurns: number; // earlier reports and answers sent again with each report (Infinity: all)
  maxBudgetUsd: number; // reached only by a service that reports a cost (usage.cost)
  // A local model's answer is checked (localAnswer); OpenRouter's is taken as it comes
  checkAnswer: boolean;
  unreachable: (err: unknown) => string; // the error when the service cannot be reached
  redirected: (status: number) => string; // the error when it answers with a redirect
  hint: (status: number, detail: string) => string; // what to do after an HTTP error
}

// A provider's chat API for one of its models, or what is wrong with its settings in .env.local
// (a request for one of its models gets it as a 500, not retryable)
type Provider = ((id: string) => ChatApi) | string;

// A key goes into a header, which carries printable ASCII only. fetch refuses anything else, and
// its error text holds the whole header, key included (a line break pasted with the key)
function keyProblem(name: string, key: string): string | null {
  return /^[\x21-\x7e]*$/.test(key)
    ? null
    : `${name} has characters a header cannot carry (a line break or a pasted quote?); fix it in .env.local and restart the dev server.`;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const SET_OPENROUTER_KEY = 'Set OPENROUTER_API_KEY in .env.local and restart the dev server.';

function openRouterProvider(key: string, maxBudgetUsd: number): Provider {
  const k = key.trim();
  if (!k) return SET_OPENROUTER_KEY;
  const problem = keyProblem('OPENROUTER_API_KEY', k);
  if (problem) return problem;
  return (id) => ({
    id,
    service: 'OpenRouter',
    started: 'OpenRouter',
    url: OPENROUTER_URL,
    key: k,
    headers: {
      'HTTP-Referer': 'https://aakin21.github.io/2D-Battle-Simulation/',
      'X-Title': '2D Battle Simulation',
    },
    body: { usage: { include: true } },
    historyTurns: Infinity,
    maxBudgetUsd,
    checkAnswer: false,
    // fetch's own text: with the key checked no header can be in it, and the key is masked anyway
    unreachable: (err) =>
      `OpenRouter could not be reached: ${capped(errorText(err).split(k).join('…'))}`,
    redirected: (status) =>
      `OpenRouter answered with a redirect (HTTP ${status}), which is not followed.`,
    hint: (status) => (status === 401 ? ` ${SET_OPENROUTER_KEY}` : ''),
  });
}

// A local model's server: LOCAL_LLM_URL is the base of an OpenAI-compatible API (Ollama's by
// default) or its chat address, LOCAL_LLM_KEY an optional key, LOCAL_LLM_HISTORY_TURNS how many
// earlier reports and answers are sent again. A local model's context window is small: the
// rulebook and one report are ~20 KB of text (roughly 6k tokens, an estimate), and a whole match
// (~33 reports, D50) would overflow it.
const DEFAULT_LOCAL_URL = 'http://localhost:11434/v1';
const DEFAULT_HISTORY_TURNS = 3;
const CHAT_PATH = '/chat/completions';

// This computer: a key sent there over plain http does not cross a network
function isLoopback(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

// A missing model (Ollama: 404 'model "x" not found, try pulling it first'; not checked against a
// running server)
const MODEL_MISSING = /model.*(not found|does not exist)|no such model/i;

// Read once, when the dev server starts (its warnings are logged then); settings that cannot work
// are the answer to every request for a local model
function localProvider(
  url: string | undefined,
  key: string,
  turns: string | undefined,
  maxBudgetUsd: number
): Provider {
  // A plain whole number; "1e9", "0x2", "1.5" or "-1" is a typo, not a number to guess from
  const t = (turns ?? '').trim();
  const historyTurns = /^\d+$/.test(t) ? Number(t) : DEFAULT_HISTORY_TURNS;
  if (t && !/^\d+$/.test(t))
    console.warn(
      `[llm] LOCAL_LLM_HISTORY_TURNS in .env.local must be a whole number (0 or more); ${DEFAULT_HISTORY_TURNS} is used.`
    );
  let u: URL | null = null;
  try {
    u = new URL((url ?? '').trim() || DEFAULT_LOCAL_URL);
  } catch {
    // not a URL: refused below
  }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:'))
    return 'LOCAL_LLM_URL in .env.local must be an http:// or https:// address (Ollama: http://localhost:11434/v1); restart the dev server after changing it.';
  // fetch refuses an address with a user name or password in it
  if (u.username || u.password)
    return 'LOCAL_LLM_URL in .env.local must not contain a user name or password: put a key in LOCAL_LLM_KEY and restart the dev server.';
  const k = key.trim(); // only spaces: no key
  const problem = keyProblem('LOCAL_LLM_KEY', k);
  if (problem) return problem;
  // The API's base, or its chat address already (not doubled)
  const path = u.pathname.replace(/\/+$/, '');
  const base = u.origin + path; // in messages and the log: without a query that may be in the URL
  u.pathname = path.endsWith(CHAT_PATH) ? path : path + CHAT_PATH;
  const chatUrl = u.href;
  if (k && u.protocol === 'http:' && !isLoopback(u.hostname))
    console.warn(
      `[llm] LOCAL_LLM_KEY goes to ${base} unencrypted (http://); use https:// for a server on another computer.`
    );
  const label = `last ${historyTurns} turn${historyTurns === 1 ? '' : 's'}`;
  return (name) => ({
    id: name,
    service: 'Local LLM',
    started: `local, ${base}, ${label}`,
    url: chatUrl,
    key: k,
    headers: {},
    body: { stream: false },
    historyTurns,
    maxBudgetUsd,
    checkAnswer: true,
    unreachable: (err) => {
      const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
      return `Local LLM could not be reached at ${base}${typeof code === 'string' ? ` (${code})` : ''}: is Ollama (or your local server) running? Set LOCAL_LLM_URL in .env.local.`;
    },
    redirected: (status) =>
      `Local LLM: the server at ${base} answered with a redirect (HTTP ${status}); set LOCAL_LLM_URL to the final address.`,
    hint: (status, detail) => {
      if (status === 401 || status === 403)
        return ' Set LOCAL_LLM_KEY in .env.local to the key the server expects and restart the dev server.';
      if (status === 404 || MODEL_MISSING.test(detail))
        return ` The server at ${base} does not know the model "${name}" (with Ollama: ollama pull ${name}), or LOCAL_LLM_URL is not its OpenAI-compatible address (Ollama's ends in /v1).`;
      return '';
    },
  });
}

// A reasoning model's thinking in its answer: "<think>…</think>" or "<thinking>…</thinking>" (any
// case, attributes), one block or more, maybe after some prose; a chat template that puts the
// opening tag in the prompt leaves only the closing one. Braces in it would reach LlmReply's JSON
// reading, which takes the text from its first "{". The answer is what follows the last closing
// tag, unless that has no "{" (an answer that only mentions the tag keeps its text); an opening
// tag that is never closed (cut off while thinking) is dropped alone, never the whole answer.
// Linear in the text's length: neither pattern can scan past the next "<" or ">".
const THINK_CLOSE = /<\/think(?:ing)?\s*>/gi;
const THINK_OPEN = /<think(?:ing)?(?:\s[^<>]*)?>/i;

function withoutThinking(text: string): string {
  let end = -1;
  for (const m of text.matchAll(THINK_CLOSE)) end = m.index + m[0].length;
  if (end < 0) return text.replace(THINK_OPEN, '');
  const rest = text.slice(end);
  return rest.includes('{') ? rest.trimStart() : text;
}

// An answer is ~1–2 KB of JSON orders; a much longer one is a model that ran on, and it would be
// sent again with each of the next reports
const MAX_ANSWER_CHARS = 200_000;

// A local model's answer text, null when it has none. It may come in parts ([{type: "text",
// text}], some servers). An answer that is empty, cut off or too large is an error, not a 200:
// the browser reads an unusable answer as no orders and goes on, so the side would stand without
// orders all match, while failures are counted and three in a row stop the layer with the message
function localAnswer(service: string, content: unknown, finishReason: unknown): string | null {
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((p) => p?.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text as string)
            .join('')
        : null;
  if (raw === null) return null;
  const text = withoutThinking(raw);
  if (!text.trim())
    throw new LlmError(
      `${service}: the answer was empty; a reasoning model may have used its whole output on thinking.`,
      true,
      true
    );
  if (finishReason === 'length')
    throw new LlmError(
      `${service}: the answer was cut off at the model's output limit; raise the server's output or context limit.`,
      true,
      true
    );
  if (text.length > MAX_ANSWER_CHARS)
    throw new LlmError(
      `${service}: the answer was ${Math.round(text.length / 1000)} KB of text, more than the ${MAX_ANSWER_CHARS / 1000} KB an answer may have.`,
      true,
      true
    );
  return text;
}

// A model behind an OpenAI-compatible chat API: OpenRouter (D52) or a local model. The API keeps
// no conversation, so the session keeps the match's messages and sends them with every request
// (the Agent SDK session keeps them on its side): all of them for OpenRouter, the last
// `historyTurns` reports and answers for a local model, always with the rulebook. One request at
// a time, like the SDK session.
class ChatSession implements LlmSession {
  private turns: Array<[report: string, answer: string]> = [];
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private costSoFar = 0;
  private abort = new AbortController();

  constructor(
    readonly matchId: string,
    readonly model: string, // "openrouter:<id>", "local:<name>"
    private readonly systemPrompt: string,
    private readonly api: ChatApi,
    side = ''
  ) {
    console.warn(`[llm] ${side} session started: ${api.id} (${api.started})`);
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
    const { api } = this;
    if (this.closed) throw sessionClosed();
    if (this.costSoFar >= api.maxBudgetUsd)
      throw new LlmError(
        `this session spent its budget of $${api.maxBudgetUsd} (LLM_MAX_BUDGET_USD)`,
        false,
        true
      );
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: this.systemPrompt },
    ];
    for (const [report, answer] of this.turns)
      messages.push({ role: 'user', content: report }, { role: 'assistant', content: answer });
    messages.push({ role: 'user', content: prompt });
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(api.url, {
        method: 'POST',
        signal: this.abort.signal,
        // Not followed: the rulebook and the report would go to whatever address it names
        redirect: 'manual',
        headers: {
          ...(api.key ? { Authorization: `Bearer ${api.key}` } : {}),
          'Content-Type': 'application/json',
          ...api.headers,
        },
        body: JSON.stringify({ model: api.id, messages, ...api.body }),
      });
    } catch (err) {
      // A lost connection keeps the conversation: the next report tries again
      throw new LlmError(this.closed ? SESSION_CLOSED : api.unreachable(err), true, true);
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      res.body?.cancel().catch(() => undefined);
      throw new LlmError(api.redirected(res.status), false, true);
    }
    const body = (await res.json().catch(() => null)) as {
      error?: string | { message?: unknown };
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
      usage?: Record<string, unknown> & { prompt_tokens_details?: Record<string, unknown> };
    } | null;
    // Closed (a new match or model) while the answer was read: the reading was aborted
    if (this.closed) throw new LlmError(SESSION_CLOSED, true, true);
    // OpenAI's form { error: { message } }; some local servers send { error: "…" }
    const error = body?.error;
    const detail = capped(
      typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : ''
    );
    if (!res.ok) {
      // A wrong key, no credits, a model that does not exist: nothing changes until someone acts
      const lasting = [400, 401, 402, 403, 404].includes(res.status);
      throw new LlmError(
        `${api.service}: ${detail || `HTTP ${res.status}`} (HTTP ${res.status}).${api.hint(res.status, detail)}`,
        !lasting,
        true
      );
    }
    const choice = body?.choices?.[0];
    const content = choice?.message?.content;
    const text = api.checkAnswer
      ? localAnswer(api.service, content, choice?.finish_reason)
      : content;
    if (typeof text !== 'string')
      throw new LlmError(
        `${api.service}: the answer had no text${detail ? ` (${detail})` : ''}`,
        true,
        true
      );
    this.turns.push([prompt, text]);
    if (this.turns.length > api.historyTurns) this.turns.shift();
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
        modelIds: [typeof body?.model === 'string' ? body.model : api.id],
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
// Bodies being read at once, at most: two sides send one request at a time, so more are not from
// the game; each may hold up to MAX_BODY_BYTES, so many at once would fill the memory. Above it a
// request gets 503 with Retry-After
const MAX_BODIES_IN_FLIGHT = 8;
const BUSY_RETRY_AFTER_S = 5;
// Two matches on one side (two tabs) take its session from each other with every request; that is
// logged at most this often per side
const REPLACED_LOG_MS = 60_000;

class TooLarge extends Error {}
class TooSlow extends Error {}
class ClientGone extends Error {}

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
  error: string,
  headers: Record<string, string> = {}
): void {
  let sent = false;
  const answer = () => {
    if (sent) return;
    sent = true;
    clearTimeout(timer);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
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

// Rejects when the client goes away before it is answered (its own timeout, a closed tab): the
// endpoint then stops waiting for that answer
function clientGone(res: ServerResponse): { gone: Promise<never>; done: () => void } {
  let onClose = () => {};
  const gone = new Promise<never>((_resolve, reject) => {
    onClose = () => {
      if (!res.writableEnded) reject(new ClientGone('the browser closed the request'));
    };
    res.on('close', onClose);
  });
  gone.catch(() => undefined); // only raced with the answer; never unhandled
  return { gone, done: () => res.off('close', onClose) };
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
  const DEFAULT_MODEL = defaultModel(env.LLM_MODEL ?? process.env.LLM_MODEL);
  const MAX_BUDGET_USD = maxBudget(env.LLM_MAX_BUDGET_USD ?? process.env.LLM_MAX_BUDGET_USD);
  const openRouter = openRouterProvider(
    env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '',
    MAX_BUDGET_USD
  );
  // From the server's own settings only: the endpoint is reachable through the tunnel (D37), so
  // an address taken from a request would let anyone make this computer call any address
  const local = localProvider(
    env.LOCAL_LLM_URL ?? process.env.LOCAL_LLM_URL,
    env.LOCAL_LLM_KEY ?? process.env.LOCAL_LLM_KEY ?? '',
    env.LOCAL_LLM_HISTORY_TURNS ?? process.env.LOCAL_LLM_HISTORY_TURNS,
    MAX_BUDGET_USD
  );
  // The chat API that runs a model, null for a Claude model of the Agent SDK, or what is wrong
  // with its provider's settings
  const chatApi = (model: string): ChatApi | null | string => {
    const routerId = openRouterId(model);
    if (routerId !== null)
      return typeof openRouter === 'string' ? openRouter : openRouter(routerId);
    const localId = localModelId(model);
    if (localId !== null) return typeof local === 'string' ? local : local(localId);
    return null;
  };
  let reading = 0; // bodies being read now (MAX_BODIES_IN_FLIGHT)
  // Per side: the match whose session was last replaced by another match's, and when that was
  // last logged
  const replaced = new Map<string, { matchId: string; loggedAt: number }>();
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
        if (reading >= MAX_BODIES_IN_FLIGHT)
          return refuseBody(req, res, 503, 'too many requests at once', {
            'Retry-After': String(BUSY_RETRY_AFTER_S),
          });
        reading++;
        try {
          body = JSON.parse(await readBody(req).finally(() => reading--));
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
          // A Claude alias, "openrouter:<id>" (D52) or "local:<name>"; a request without a model
          // gets the default, and an unknown one is refused so a typo never runs another model
          if (requested !== undefined && typeof requested !== 'string')
            return send(res, 400, { error: 'model must be text' });
          const model: string = requested ?? DEFAULT_MODEL;
          if (!isLlmModel(model))
            return send(res, 400, { error: `unknown model ${model.slice(0, 80)}` });
          const chat = chatApi(model);
          if (typeof chat === 'string') return send(res, 500, { error: chat, retryable: false });
          if (
            !session ||
            !session.isAlive() ||
            session.matchId !== matchId ||
            session.model !== model
          ) {
            if (session?.isAlive() && session.matchId !== matchId) {
              // Another match took this side's session: two tabs playing at once take it from
              // each other with every request, each time losing the match's conversation (D11)
              const last = replaced.get(side);
              let loggedAt = last?.loggedAt ?? -Infinity;
              const now = Date.now();
              if (last?.matchId === matchId && now - loggedAt >= REPLACED_LOG_MS) {
                console.warn(
                  `[llm] ${side}: two matches use this side at once (two tabs?); each request starts a new session and the LLM loses the match's conversation`
                );
                loggedAt = now;
              }
              replaced.set(side, { matchId: session.matchId, loggedAt });
            }
            session?.close();
            session = chat
              ? new ChatSession(matchId, model, system, chat, side)
              : new Session(matchId, model as Model, system, MAX_BUDGET_USD, side);
            sessions.set(side, session);
          }

          const started = Date.now();
          let answer: Answer;
          const client = clientGone(res);
          try {
            answer = await Promise.race([
              withTimeout(session.ask(prompt), LLM_SERVER_TIMEOUT_MS),
              client.gone,
            ]);
          } catch (err) {
            // The browser gave up on this answer (its timeout, a restart, a closed tab): it is not
            // waited for. The session stays, so the match keeps its conversation; its answer to
            // this report comes later and is dropped
            if (err instanceof ClientGone) {
              console.warn(`[llm] ${side} (${model}): ${err.message}; its answer is dropped`);
              return;
            }
            // A session that hangs or ended is closed; the next request starts a fresh one. An
            // error reported in a result (overloaded, rate limited) leaves the session working,
            // and closing it would lose the match's conversation (in-match memory, D11).
            if (!(err instanceof LlmError && err.fromResult)) {
              session.close();
              if (sessions.get(side) === session) sessions.delete(side);
            }
            throw err;
          } finally {
            client.done();
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
          console.warn(`[llm] ${side} (${String(requested ?? DEFAULT_MODEL)}): ${errorText(err)}`);
          // retryable tells the browser to try again at its next report instead of stopping
          send(res, 500, {
            error: errorText(err),
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
