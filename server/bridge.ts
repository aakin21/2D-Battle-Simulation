import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as util from 'node:util';
import { isLocalModelName } from '../src/ai/Models';
import { DEFAULT_BRIDGE_PORT } from '../src/ai/Limits';
import { aiAccess, allowedOrigins, deny } from './aiAccess';
import { llmEndpoint, refuseBody, send, type LlmEndpoint } from './llmEndpoint';
import { localServer, openRouterProvider, type LocalServer } from './chatSession';
import type { QueryFn } from './claudeSession';
import { bridgeClaude } from './bridgeClaude';
import type { CliStatus } from './cliTools';

// The AI bridge: the dev server's POST /api/llm (llmEndpoint.ts) without Vite, on this computer
// only, so the published static demo can use the player's own model: a local server such as
// Ollama, their own OpenRouter key, Claude through the Agent SDK (their Claude Code sign-in or
// their Anthropic API key: bridgeClaude.ts), Codex through the Codex CLI installed on their
// computer (their Codex sign-in), Gemini with their GEMINI_API_KEY, or a command of their own
// settings (cliTools.ts). The demo opened with ?ai=http://127.0.0.1:<port> (the link the bridge
// opens when it starts) sends its requests here (src/ai/AiServer.ts). The bridge exposes the
// player's model and keys to web pages, so it
// answers only requests addressed to this computer (Host) from the allowed sites and pages on this
// computer (Origin, aiAccess.ts), and listens on the loopback address alone. Started by
// bridgeCli.ts (npm run bridge, or the bundled file run with node).

// Changes when what the bridge answers changes (GET /api/bridge)
export const BRIDGE_VERSION = '1.1.0';
// The default port, shared with the page's connect to the AI bridge (src/ai/Limits.ts)
export { DEFAULT_BRIDGE_PORT };
// The published demo (README.md); its origin is the default of AI_ALLOWED_ORIGINS (aiAccess.ts)
export const DEMO_URL = 'https://aakin21.github.io/2D-Battle-Simulation/';
// The only address the bridge listens on: never a network interface, never 0.0.0.0
const LOOPBACK = '127.0.0.1';
// In messages that say what to restart after a setting changed
const BRIDGE = 'the bridge';

// The settings the bridge reads; anything else in .env.local (the decision models' keys, the AI
// password) is not read
export const SETTINGS = [
  'LOCAL_LLM_URL',
  'LOCAL_LLM_KEY',
  'LOCAL_LLM_HISTORY_TURNS',
  'LLM_MODEL',
  'LLM_MAX_BUDGET_USD',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_PATH',
  'AI_ALLOWED_ORIGINS',
  'BRIDGE_PORT',
  'BRIDGE_OPEN',
  'CLI_TOOLS',
  'CLI_HISTORY_TURNS',
] as const;

// Besides SETTINGS: a command of the player's own (CLI_TOOL_<NAME>)
const CLI_SETTING = /^CLI_TOOL_[A-Z0-9_]+$/;

export interface Settings {
  env: Record<string, string>;
  file: string | null; // the .env.local that was read
  problem: string | null; // why a .env.local that is there was not read
}

// The settings from the environment and from .env.local in `dir`. As with the dev server (Vite's
// loadEnv), a variable set in the environment wins over the same one in .env.local.
export function loadSettings(dir: string, environment: NodeJS.ProcessEnv = process.env): Settings {
  const path = join(dir, '.env.local');
  let fromFile: NodeJS.Dict<string> = {};
  let file: string | null = null;
  let problem: string | null = null;
  let text: string | null = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code !== 'ENOENT') problem = `.env.local could not be read (${String(code)})`;
  }
  if (text !== null) {
    if (typeof util.parseEnv !== 'function')
      problem = 'this Node.js cannot read .env.local (Node 20.12 or newer can)';
    else {
      fromFile = util.parseEnv(text);
      file = path;
    }
  }
  const env: Record<string, string> = {};
  const cliNames = [...Object.keys(fromFile), ...Object.keys(environment)].filter((n) =>
    CLI_SETTING.test(n)
  );
  for (const name of new Set<string>([...SETTINGS, ...cliNames])) {
    const value = environment[name] ?? fromFile[name];
    if (value !== undefined) env[name] = value;
  }
  return { env, file, problem };
}

// A port number as typed (0: any free port)
export function parsePort(value: string): number | null {
  const v = value.trim();
  return /^\d{1,5}$/.test(v) && Number(v) <= 65535 ? Number(v) : null;
}

// The local server's models (an OpenAI-compatible GET <base>/models, Ollama's included), or null
// when it does not answer in time or answers something else. Only names a model id may have
// (Models.ts) are listed. Never follows a redirect, as the chat requests (chatSession.ts).
const MODELS_TIMEOUT_MS = 2000;
const MAX_MODELS_BYTES = 1_000_000;
const MAX_MODELS = 200;

export async function listLocalModels(
  local: LocalServer,
  key: string,
  timeoutMs = MODELS_TIMEOUT_MS
): Promise<string[] | null> {
  try {
    const res = await fetch(local.modelsUrl, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200 || !res.body) {
      res.body?.cancel().catch(() => undefined);
      return null;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      size += r.value.length;
      if (size > MAX_MODELS_BYTES) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(r.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: unknown } | null;
    if (!Array.isArray(body?.data)) return null;
    const ids = (body.data as Array<{ id?: unknown } | null>)
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string' && isLocalModelName(id));
    return [...new Set(ids)].slice(0, MAX_MODELS);
  } catch {
    // unreachable, too slow, not JSON; fetch's own text is never shown (it may hold the key)
    return null;
  }
}

// GET /api/bridge: what this bridge can run. Never a secret: whether a key is set, not the key;
// the local server's origin, not its address's path, query or credentials. The dev server answers
// the same at the same path with `bridge: false` (llmPlugin.ts), for the page it serves.
export interface BridgeStatus {
  bridge: boolean; // true: the AI bridge; false: the dev server
  version: string;
  llm: {
    claude: boolean; // the Agent SDK could be loaded (and ANTHROPIC_API_KEY, when set, can be sent)
    // The Codex CLI is installed (codex on PATH or CODEX_PATH, found without running it); why
    // not when it is not
    codex: { available: boolean; reason?: string };
    gemini: boolean; // GEMINI_API_KEY is set and can be sent
    local: { url: string | null; models: string[] | null };
    openrouter: boolean; // OPENROUTER_API_KEY is set and can be sent
    // Commands of the player's own settings (CLI_TOOL_<NAME>): id ("cli:<name>"), label, and
    // whether the executable is there; empty with CLI_TOOLS=off
    custom: CliStatus[];
  };
}

export interface BridgeOptions {
  port: number; // 0: any free port
  env: Record<string, string>; // loadSettings().env
  // The Agent SDK's query(), null when the SDK is not installed (bridgeCli.ts loads it)
  sdkQuery: QueryFn | null;
}

export interface Bridge {
  port: number;
  url: string; // http://127.0.0.1:<port>
  status: () => Promise<BridgeStatus>;
  close: () => Promise<void>;
}

// What an LLM endpoint can run, as GET /api/bridge's `llm`: the bridge's, and the dev server's
// (llmPlugin.ts). The settings are read once, here; the local server's models and the ways of the
// endpoint (Codex, Gemini, commands) at each call. `claude`: whether the Agent SDK is there.
export function llmStatus(
  env: Record<string, string | undefined>,
  endpoint: Pick<LlmEndpoint, 'ways'>,
  claude: boolean,
  server: string
): () => Promise<BridgeStatus['llm']> {
  const local = localServer(env.LOCAL_LLM_URL, server);
  const localKey = (env.LOCAL_LLM_KEY ?? '').trim();
  const keyUsable = /^[\x21-\x7e]*$/.test(localKey);
  const openrouter =
    typeof openRouterProvider(env.OPENROUTER_API_KEY ?? '', 0, server) !== 'string';
  return async () => {
    const ways = await endpoint.ways();
    return {
      claude,
      codex: ways.codex,
      gemini: ways.gemini,
      local:
        typeof local === 'string'
          ? { url: null, models: null }
          : {
              url: local.origin,
              models: keyUsable ? await listLocalModels(local, localKey) : null,
            },
      openrouter,
      custom: ways.custom,
    };
  };
}

// The decision models (Jev, SubQ Snap) are not served: their keys are the author's (D7), and the
// dev server's proxies are Vite's. The browser stops its tactical layer at once on a 404, and the
// LLM goes on alone (src/ai/AiLayer.ts).
const tacticalMissing = (name: string) =>
  `${name} is not available through the AI bridge, which serves the LLM only: choose "LLM" for this side in the Battle menu.`;

export function startBridge(options: BridgeOptions): Promise<Bridge> {
  const { env } = options;
  // The Claude models through the Agent SDK, or why they are off
  const claude = bridgeClaude(options.sdkQuery, env.ANTHROPIC_API_KEY);
  const endpoint = llmEndpoint(env, { query: claude, server: BRIDGE });
  // Every request is addressed to this computer (the Host check below), so the AI password is
  // never asked for. No Private Network Access answer (Access-Control-Allow-Private-Network):
  // Chrome's Local Network Access replaced it (a permission the user grants, Chrome 142), its
  // preflights were never enforced, and Chrome's guide says not to add it to new code.
  const guard = aiAccess(
    env.AI_ALLOWED_ORIGINS === undefined ? {} : { AI_ALLOWED_ORIGINS: env.AI_ALLOWED_ORIGINS },
    { loopbackOrigins: true }
  );
  const runs = llmStatus(env, endpoint, typeof claude === 'function', BRIDGE);
  const status = async (): Promise<BridgeStatus> => ({
    bridge: true,
    version: BRIDGE_VERSION,
    llm: await runs(),
  });

  let hosts = new Set<string>();
  const route = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/api/llm') {
      endpoint.handle(req, res).catch((err: unknown) => {
        console.warn(
          `[bridge] /api/llm failed: ${err instanceof Error ? err.message : String(err)}`
        );
        if (!res.headersSent) send(res, 500, { error: 'the bridge failed to answer' });
        else res.destroy();
      });
      return;
    }
    if (path === '/api/bridge') {
      if (req.method !== 'GET') return refuseBody(req, res, 405, 'GET only', { Allow: 'GET' });
      void status().then((s) => {
        res.setHeader('Cache-Control', 'no-store');
        send(res, 200, s);
      });
      return;
    }
    if (path === '/api/jev' || path === '/api/snap') {
      if (req.method !== 'POST')
        return refuseBody(req, res, 405, 'only POST is accepted', { Allow: 'POST' });
      return refuseBody(req, res, 404, tacticalMissing(path === '/api/jev' ? 'Jev' : 'SubQ Snap'));
    }
    refuseBody(req, res, 404, 'not found');
  };

  const server = http.createServer((req, res) => {
    // No answer is ever read as a script or a page
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // DNS rebinding: a site whose name is made to resolve to 127.0.0.1 reaches this port with its
    // own name in the Host header (and counts as the same origin as the bridge in the browser)
    if (!hosts.has(req.headers.host ?? ''))
      return deny(res, 403, 'the bridge answers only requests addressed to localhost or 127.0.0.1');
    guard(req, res, () => route(req, res));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: options.port, host: LOOPBACK, exclusive: true }, () => {
      server.off('error', reject);
      const port = (server.address() as AddressInfo).port;
      const names = ['localhost', '127.0.0.1', '[::1]'];
      hosts = new Set([...names.map((n) => `${n}:${port}`), ...(port === 80 ? names : [])]);
      resolve({
        port,
        url: `http://${LOOPBACK}:${port}`,
        status,
        close: () =>
          new Promise<void>((done) => {
            endpoint.close();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

// The link that opens the demo with this bridge, or null when the demo's site is not among the
// allowed origins (AI_ALLOWED_ORIGINS names other sites)
export function demoLink(env: Record<string, string>, bridgeUrl: string): string | null {
  return allowedOrigins(env).has(new URL(DEMO_URL).origin) ? `${DEMO_URL}?ai=${bridgeUrl}` : null;
}
