import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CLAUDE_MODELS,
  isLlmModel,
  localModelId,
  openRouterId,
  type ClaudeModel,
} from '../src/ai/Models';
import { LLM_SERVER_TIMEOUT_MS } from '../src/ai/Limits';
import { LlmError, errorText, type Answer, type LlmSession } from './llmSession';
import { ClaudeSession } from './claudeSession';
import { ChatSession, localProvider, openRouterProvider, type ChatApi } from './chatSession';

// Layer 3 (D10): the strategic LLM runs in the dev server through the Claude Agent SDK,
// using the developer's own Claude login. One persistent session per side, so a decision
// takes ~1–2 s instead of ~8 s (R2), and the LLM remembers earlier decisions within a match
// (in-match memory, D11). A new match id starts a fresh session.
//
// POST /api/llm  { side, matchId, system, prompt, model }  →  { text, latencyMs, model }

// The system prompt (rulebook) is built in the browser from the engine's own constants
// (src/ai/GameRules.ts) and sent with each request; it is used when a session starts.

// The model of a request that names none: LLM_MODEL from .env.local or the shell (read in
// llmPlugin, from the env vite.config.ts loads)
function defaultModel(value: string | undefined): ClaudeModel {
  return (CLAUDE_MODELS as readonly string[]).includes(value ?? '')
    ? (value as ClaudeModel)
    : 'sonnet';
}

// A session's estimated spend (the SDK's total_cost_usd, or the sum of a chat API's usage.cost)
// above which it stops answering, so a runaway session cannot spend without limit. A match makes
// ~33 requests per side (every 15 s, D50). LLM_MAX_BUDGET_USD from .env.local or the shell, 5 by
// default.
function maxBudget(value: string | undefined): number {
  return Number(value) || 5;
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
              : new ClaudeSession(matchId, model as ClaudeModel, system, MAX_BUDGET_USD, side);
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
