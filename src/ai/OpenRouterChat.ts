import { OPENROUTER_ORIGIN, errorDetail, openRouterFetch, withoutKey } from './OpenRouterConnect';

// An OpenRouter model straight from the browser, on the key of the visitor's own account
// ("Connect with OpenRouter", OpenRouterConnect.ts). It stands in for /api/llm: `fetch` takes the
// request LlmController would send there and answers as the endpoint does (200 { text, model,
// costUsd, tokens, apiMs, modelIds }, or { error, retryable }), so the layer's timeout, one request
// at a time, dispose, failure counting, exchanges and match log work as for the server.
//
// The rules follow the dev server's chat session for OpenRouter (server/chatSession.ts), with two
// differences: only the last DIRECT_HISTORY_TURNS reports and answers are sent again (the server
// sends the whole match: on the visitor's own money that is ~$5 per side and match at Sonnet's
// prices), and an error's status is OpenRouter's own (the layer shows "HTTP 429: …").

const CHAT_PATH = '/api/v1/chat/completions';
export const DIRECT_CHAT_URL = OPENROUTER_ORIGIN + CHAT_PATH;
// Earlier reports and answers sent again with each report, besides the rulebook and the new
// report (the dev server's default for a local model, LOCAL_LLM_HISTORY_TURNS)
export const DIRECT_HISTORY_TURNS = 3;
// A side stops asking once its answers this match cost this much (OpenRouter's usage.cost): the
// AI server's LLM_MAX_BUDGET_USD default, per side and match as there
export const DIRECT_MAX_SPEND_USD = 5;
// An answer is ~1–2 KB of JSON orders; a much longer one is a model that ran on, and it would be
// sent again with the next reports
const MAX_ANSWER_CHARS = 200_000;

// OpenRouter's limits on free models (its docs, 2026-11-21): the likeliest 429 on a visitor's
// account. A match asks ~32 times per side (every 15 s, D50)
const FREE_LIMITS =
  'free models allow 20 requests/min and 50/day (1,000/day after buying 10 credits); a match asks ~32 times per side.';

// A request that did not give a usable answer: the endpoint's { error, retryable } with a status
class Refusal {
  constructor(
    readonly error: string,
    readonly retryable: boolean,
    readonly status = 500
  ) {}
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A 429: OpenRouter's rate limit. When OpenRouter says the limit is used up until more than a
// minute from now (X-RateLimit-Remaining 0, X-RateLimit-Reset in ms), asking again cannot help.
function rateLimited(detail: string, headers: Headers, now: number): Refusal {
  const reset = Number(headers.get('x-ratelimit-reset'));
  const later =
    headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset) && reset - now > 60_000;
  const until = later ? ` until ${new Date(reset).toLocaleTimeString()}` : '';
  return new Refusal(
    `OpenRouter's rate limit${until}: ${FREE_LIMITS}${detail ? ` ${detail}` : ''}`,
    !later,
    429
  );
}

// An error status from OpenRouter, with what to do. A wrong key, no credits or a model that does
// not exist (400–404) stay until someone acts: not retryable, as on the server.
function refused(status: number, detail: string, headers: Headers, id: string): Refusal {
  const d = detail ? ` ${detail}` : '';
  switch (status) {
    case 429:
      return rateLimited(detail, headers, Date.now());
    case 401:
      return new Refusal(
        `OpenRouter no longer takes the key (it ended or was deleted): Disconnect, connect again and restart the match.${d}`,
        false,
        status
      );
    case 402:
      return new Refusal(
        `no OpenRouter credits left for this model (your account, or the key's limit): choose a free model (:free) or add credits.${d}`,
        false,
        status
      );
    case 404:
      return new Refusal(`OpenRouter does not know the model ${id}.${d}`, false, status);
    default:
      return new Refusal(
        `OpenRouter:${d || ` HTTP ${status}`}`,
        ![400, 401, 402, 403, 404].includes(status),
        status
      );
  }
}

// The answer's text: a string, or text parts joined
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

interface ChatAnswer {
  error?: unknown;
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown; error?: unknown }>;
  usage?: Record<string, unknown> & { prompt_tokens_details?: Record<string, unknown> };
}

// One side's conversation with one OpenRouter model for one match: the rulebook as the system
// message, then reports and answers. One request at a time (AiLayer sends no other while one is
// open).
export class OpenRouterSession {
  private turns: Array<[report: string, answer: string]> = [];
  private spent = 0;

  constructor(
    private readonly id: string, // OpenRouter's model id
    private readonly model: string // "openrouter:<id>", as the menu and the match log name it
  ) {}

  // Takes the request LlmController sends to /api/llm and answers as /api/llm does. An aborted
  // request (the layer's timeout, the end of the match) throws, as fetch does.
  readonly fetch = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      return json(200, await this.ask(String(init?.body ?? ''), init?.signal ?? undefined));
    } catch (err) {
      // Never the key in what the layer keeps and shows (errorDetail masks OpenRouter's text
      // already; this is for any other text that went into the message)
      if (err instanceof Refusal)
        return json(err.status, { error: withoutKey(err.error), retryable: err.retryable });
      throw err;
    }
  };

  private async ask(
    raw: string,
    signal: AbortSignal | undefined
  ): Promise<Record<string, unknown>> {
    const request = JSON.parse(raw) as { system?: unknown; prompt?: unknown };
    const { system, prompt } = request;
    if (typeof system !== 'string' || typeof prompt !== 'string')
      throw new Refusal('the request has no rulebook or report', false);
    if (this.spent >= DIRECT_MAX_SPEND_USD)
      throw new Refusal(
        `this side's OpenRouter answers cost $${this.spent.toFixed(2)} this match, the most the browser spends per side and match ($${DIRECT_MAX_SPEND_USD}).`,
        false
      );
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: system },
    ];
    for (const [report, answer] of this.turns)
      messages.push({ role: 'user', content: report }, { role: 'assistant', content: answer });
    messages.push({ role: 'user', content: prompt });

    const started = performance.now();
    let res: Response | null;
    try {
      res = await openRouterFetch(
        CHAT_PATH,
        JSON.stringify({ model: this.id, messages, usage: { include: true } }),
        signal
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Refusal(`OpenRouter could not be reached: ${errorText(err).slice(0, 200)}`, true);
    }
    if (res === null)
      throw new Refusal(
        'not connected to OpenRouter any more (Disconnect): connect again (AI connections, on the title screen) and restart the match.',
        false
      );
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      res.body?.cancel().catch(() => undefined);
      throw new Refusal(
        `OpenRouter answered with a redirect${res.status ? ` (HTTP ${res.status})` : ''}, which is not followed.`,
        false
      );
    }
    const body = (await res.json().catch((err: unknown) => {
      if (signal?.aborted) throw err;
      return null;
    })) as ChatAnswer | null;
    const apiMs = Math.round(performance.now() - started);
    if (!res.ok) throw refused(res.status, errorDetail(body), res.headers, this.id);
    if (!body) throw new Refusal('OpenRouter: the answer was not JSON.', true);

    // An error after the model began answering comes with status 200, at the top or on the choice
    const choice = body.choices?.[0];
    const error = body.error ?? choice?.error;
    if (error !== undefined && error !== null) {
      const detail = errorDetail({ error });
      const code = num((error as { code?: unknown }).code);
      if (code === 429) throw rateLimited(detail, res.headers, Date.now());
      throw new Refusal(`OpenRouter: the model failed while answering. ${detail}`.trim(), true);
    }
    // An unusable answer is an error, never a 200: the layer would read it as no orders and go on
    // (the side standing without orders), while failures are counted and three in a row stop it
    const text = contentText(choice?.message?.content);
    if (text === null) throw new Refusal('OpenRouter: the answer had no text.', true);
    if (!text.trim())
      throw new Refusal(
        'OpenRouter: the answer was empty (a reasoning model may have used its whole output on thinking, or the model is starting up).',
        true
      );
    if (choice?.finish_reason === 'length')
      throw new Refusal("OpenRouter: the answer was cut off at the model's output limit.", true);
    if (choice?.finish_reason === 'error')
      throw new Refusal('OpenRouter: the model failed while answering.', true);
    if (text.length > MAX_ANSWER_CHARS)
      throw new Refusal(
        `OpenRouter: the answer was ${Math.round(text.length / 1000)} KB of text, more than the ${MAX_ANSWER_CHARS / 1000} KB an answer may have.`,
        true
      );

    this.turns.push([prompt, text]);
    if (this.turns.length > DIRECT_HISTORY_TURNS) this.turns.shift();
    const usage = body.usage ?? {};
    const costUsd = num(usage.cost);
    if (costUsd !== null) this.spent += costUsd;
    return {
      text,
      latencyMs: apiMs,
      model: this.model,
      costUsd,
      inputTokens: num(usage.prompt_tokens), // cached input included, as the server counts it
      outputTokens: num(usage.completion_tokens),
      cacheReadTokens: num(usage.prompt_tokens_details?.cached_tokens),
      cacheWriteTokens: num(usage.prompt_tokens_details?.cache_write_tokens),
      apiMs,
      turns: 1,
      modelIds: [typeof body.model === 'string' ? body.model : this.id],
    };
  }
}
