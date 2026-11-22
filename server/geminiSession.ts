import {
  LlmError,
  SESSION_CLOSED,
  errorText,
  num,
  sessionClosed,
  type Answer,
  type LlmSession,
} from './llmSession';
import { DEV_SERVER, MAX_ANSWER_CHARS, capped, keyProblem } from './chatSession';

// A model "gemini:<model>": Google's Gemini through the Gemini API's Interactions API, with the
// GEMINI_API_KEY of the server's own settings. A session per side and match, as Claude's: Google
// keeps the conversation (server-side state, "store"), and each report continues it with
// previous_interaction_id, so a request carries the new report alone, not the earlier ones. The
// rulebook goes as system_instruction with every request: "previous_interaction_id preserves only
// the conversation history (inputs and outputs)", and system_instruction, tools and
// generation_config "must be re-specified in each new interaction"
// (aistudio.google.com/docs/interactions-overview, read 2026-11-22). Google retains stored
// interactions for 55 days (paid tier) or 1 day (free tier). A conversation that is lost (expired
// or deleted: the API refuses the previous id) starts again with the report at hand.
// The stable v1 endpoint (interactions-v1.openapi.json; the overview's examples use v1beta): POST
// /v1/interactions { model, input, system_instruction, previous_interaction_id } → an Interaction
// { id, status, steps: [{ type: "model_output", content: [{ type: "text", text }] }, …],
// usage: { total_input_tokens, total_output_tokens, total_cached_tokens, … } }; errors
// { error: { code, message } }.
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1/interactions';

export interface GeminiApi {
  id: string; // the Gemini API's model name
  key: string; // sent as x-goog-api-key; printable ASCII only (keyProblem)
  server: string; // in messages that say what to restart
}

const setGeminiKey = (server: string) => `Set GEMINI_API_KEY in .env.local and restart ${server}.`;

// The Gemini API for one of its models, or what is wrong with GEMINI_API_KEY (a request for a
// Gemini model gets it as a 500, not retryable)
export function geminiProvider(
  key: string,
  server = DEV_SERVER
): ((id: string) => GeminiApi) | string {
  const k = key.trim();
  if (!k) return setGeminiKey(server);
  const problem = keyProblem('GEMINI_API_KEY', k, server);
  if (problem) return problem;
  return (id) => ({ id, key: k, server });
}

// The conversation Google kept is gone: the next try starts a new one
class Lost extends Error {}

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export class GeminiSession implements LlmSession {
  private previous: string | null = null; // the last completed interaction of this conversation
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private abort = new AbortController();

  constructor(
    readonly matchId: string,
    readonly model: string, // "gemini:<model>"
    private readonly systemPrompt: string,
    private readonly api: GeminiApi,
    private readonly side = ''
  ) {
    console.warn(
      `[llm] ${side} session started: ${api.id} (Gemini Interactions API, the conversation kept by Google)`
    );
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
    try {
      return await this.interact(prompt, this.previous);
    } catch (err) {
      if (!(err instanceof Lost)) throw err;
      console.warn(
        `[llm] ${this.side} (${this.model}): the conversation Google kept was lost (${err.message}); a new one starts with this report`
      );
      this.previous = null;
      return this.interact(prompt, null);
    }
  }

  private async interact(prompt: string, previous: string | null): Promise<Answer> {
    const { api } = this;
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(GEMINI_URL, {
        method: 'POST',
        signal: this.abort.signal,
        // Not followed: the rulebook and the report would go to whatever address it names
        redirect: 'manual',
        headers: { 'x-goog-api-key': api.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: api.id,
          input: prompt,
          system_instruction: this.systemPrompt,
          ...(previous === null ? {} : { previous_interaction_id: previous }),
        }),
      });
    } catch (err) {
      // fetch's own text, the key masked (it is checked, so no header can be in it anyway)
      throw new LlmError(
        this.closed
          ? SESSION_CLOSED
          : `Gemini could not be reached: ${capped(errorText(err).split(api.key).join('…'))}`,
        true,
        true
      );
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      res.body?.cancel().catch(() => undefined);
      throw new LlmError(
        `Gemini answered with a redirect (HTTP ${res.status}), which is not followed.`,
        false,
        true
      );
    }
    const body = record(await res.json().catch(() => null));
    if (this.closed) throw new LlmError(SESSION_CLOSED, true, true);
    const error = body?.error;
    const message = typeof error === 'string' ? error : record(error)?.message;
    const detail = capped(typeof message === 'string' ? message : '');
    if (!res.ok) {
      // The API no longer has the conversation this request continues
      if (
        previous !== null &&
        (res.status === 404 ||
          (res.status === 400 &&
            /previous_interaction|interaction[^.]*(?:not found|expired|does not exist)/i.test(
              detail
            )))
      )
        throw new Lost(`HTTP ${res.status}`);
      const lasting = [400, 401, 403, 404].includes(res.status);
      const hint =
        res.status === 401 || res.status === 403
          ? ` Check GEMINI_API_KEY in .env.local and restart ${api.server}.`
          : res.status === 404
            ? ` The Gemini API may not know the model "${api.id}".`
            : res.status === 429
              ? ' The key reached a rate limit or its quota (the free tier has low limits).'
              : '';
      throw new LlmError(
        `Gemini: ${detail || `HTTP ${res.status}`} (HTTP ${res.status}).${hint}`,
        !lasting,
        true
      );
    }
    const status = body?.status;
    if (status !== 'completed') {
      const failure = Array.isArray(body?.errors)
        ? body.errors.map((e) => record(e)?.message).filter((m) => typeof m === 'string')
        : [];
      throw new LlmError(
        status === 'incomplete'
          ? "Gemini: the answer was cut off at the model's output limit."
          : `Gemini: the interaction ended as ${capped(String(status ?? 'unknown'))}${failure.length ? ` (${capped(failure.join('; '))})` : ''}.`,
        true,
        true
      );
    }
    // The model's text: its output steps' text parts (thoughts and anything else left out)
    const steps = Array.isArray(body?.steps) ? body.steps : [];
    const text = steps
      .map(record)
      .filter((s) => s?.type === 'model_output' && Array.isArray(s.content))
      .flatMap((s) => s!.content as unknown[])
      .map(record)
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c!.text as string)
      .join('');
    // An empty or oversized answer is an error, never a 200 (the browser would read it as no
    // orders), and is not part of the conversation's next request
    if (!text.trim()) throw new LlmError('Gemini: the answer was empty.', true, true);
    if (text.length > MAX_ANSWER_CHARS)
      throw new LlmError(
        `Gemini: the answer was ${Math.round(text.length / 1000)} KB of text, more than the ${MAX_ANSWER_CHARS / 1000} KB an answer may have.`,
        true,
        true
      );
    // The next report continues from this interaction; without an id it cannot, and starts anew
    this.previous = typeof body?.id === 'string' && body.id ? body.id : null;
    const usage = record(body?.usage) ?? {};
    return {
      text,
      meta: {
        costUsd: null, // the API reports none
        inputTokens: num(usage.total_input_tokens),
        outputTokens: num(usage.total_output_tokens),
        cacheReadTokens: num(usage.total_cached_tokens),
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
