import {
  LlmError,
  SESSION_CLOSED,
  errorText,
  num,
  sessionClosed,
  type Answer,
  type LlmSession,
} from './llmSession';

// D52: a model "openrouter:<id>" runs that OpenRouter model instead (OPENROUTER_API_KEY), for
// the comparison of LLMs of different companies. Its session keeps the match's conversation
// here and sends it with every request, as OpenRouter's API keeps none.
//
// A model "local:<name>" runs on the user's own computer (Ollama, LM Studio, llama.cpp) or any
// other OpenAI-compatible chat API, at LOCAL_LLM_URL. Paid APIs cost too much for every player
// to run the LLM; a local model costs nothing, if it answers within the 15 s interval.

// The most of a service's own error text that goes into a message and the log: a server may send
// megabytes of it
const MAX_DETAIL = 300;
const capped = (text: string): string =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;

// An OpenAI-compatible chat API that runs one model: OpenRouter (D52), or a local model's server.
// What differs between them is set here; the session that talks to them is the same.
export interface ChatApi {
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

export function openRouterProvider(key: string, maxBudgetUsd: number): Provider {
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
export function localProvider(
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
export class ChatSession implements LlmSession {
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
