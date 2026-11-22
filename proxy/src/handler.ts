// The tactical proxy's HTTP side: the published demo (a static site) sends its tactical layer's
// requests here, and the proxy forwards them to Jev (TypeSafe) or SubQ Snap with the author's key
// (D7: the keys never reach the browser), within the quota of quota.ts. The same hygiene as the
// dev server's proxies (vite.config.ts) and the earlier Vercel function (api/jev.ts): POST only, a
// size limit, only Content-Type and Accept passed on (plus the key), none of the service's
// cookies, CORS headers, Location or Vary passed back, a redirect never followed, a silent service
// answered with 504 after JEV_PROXY_TIMEOUT_MS. Plain Request/Response: the handler takes `env`, so
// it runs in Node with a fake counter (the smoke tests) as on Cloudflare.

import { JEV_MAX_REQUEST_SIZE, JEV_PROXY_TIMEOUT_MS } from '../../src/ai/Limits';
import { clientKey, counterName, sameSecret } from './client';
import type { Env } from './env';
import {
  DEFAULT_MATCHES_PER_DAY,
  MATCH_MAX_REQUESTS,
  MATCH_WINDOW_MS,
  resetsAt,
  type QuotaStub,
  type QuotaView,
  type Refusal,
  type TakeResult,
} from './quota';

export const DEFAULT_ALLOWED_ORIGIN = 'https://aakin21.github.io';

// Both services take the same request at the same path (vite.config.ts)
const UPSTREAM_PATH = '/v1/systemone';

export interface HandlerOptions {
  upstream: { jev: string; snap: string }; // the services' origins (code, never a setting)
  upstreamTimeoutMs: number;
  now: () => number;
}

export const DEFAULT_OPTIONS: Readonly<HandlerOptions> = {
  upstream: { jev: 'https://api.typesafe.ai', snap: 'https://api.subq.ai' },
  upstreamTimeoutMs: JEV_PROXY_TIMEOUT_MS,
  now: () => Date.now(),
};

interface ServiceRoute {
  kind: 'service';
  method: 'POST';
  model: 'jev' | 'snap';
  label: string;
  service: string;
  key: 'TYPESAFE_API_KEY' | 'SUBQ_API_KEY';
}
interface StatusRoute {
  kind: 'status';
  method: 'GET';
}

// Exact paths (a query is allowed and never passed on)
const ROUTES = new Map<string, ServiceRoute | StatusRoute>([
  [
    '/api/jev',
    {
      kind: 'service',
      method: 'POST',
      model: 'jev',
      label: 'Jev',
      service: 'TypeSafe',
      key: 'TYPESAFE_API_KEY',
    },
  ],
  [
    '/api/snap',
    {
      kind: 'service',
      method: 'POST',
      model: 'snap',
      label: 'Snap',
      service: 'SubQ',
      key: 'SUBQ_API_KEY',
    },
  ],
  ['/api/tactical', { kind: 'status', method: 'GET' }],
]);

// What the page may send: its JSON, the match id and the author's key
const PAGE_HEADERS = 'Content-Type, Accept, x-match-id, x-ai-key';
// What the page may read besides the CORS-safelisted headers: the services' wait hints (the page's
// retries honour them, AiServer.ts) and the quota's
const EXPOSED_HEADERS = 'Retry-After, retry-after-ms, x-tactical-quota, x-tactical-matches-left';
// Chrome keeps a preflight at most 2 hours, Firefox a day
const PREFLIGHT_MAX_AGE = '7200';
// The services' wait hints, passed back
const PASSED_HEADERS = ['retry-after', 'retry-after-ms'];
// Statuses whose answer has no body
const NULL_BODY = new Set([204, 205]);
// The page's match id: `match_<ms>_<base 36>` (LlmController), or any id of these characters
const MATCH_ID = /^[A-Za-z0-9_-]{8,64}$/;

const NO_ADDRESS = 'cannot tell the address this request comes from';
const COUNTER_DOWN = 'the match counter is not available now; nothing was sent';

// The origins whose pages may call the proxy: ALLOWED_ORIGINS (comma-separated), the demo's when
// it is unset or blank; an entry that is not an http(s) origin is left out
export function allowedOrigins(value: string | undefined): Set<string> {
  if (!value?.trim()) return new Set([DEFAULT_ALLOWED_ORIGIN]);
  const out = new Set<string>();
  for (const item of value.split(',')) {
    try {
      const url = new URL(item.trim());
      const bare = url.pathname === '/' && !url.search && !url.hash && !url.username;
      if ((url.protocol === 'https:' || url.protocol === 'http:') && bare && !url.password)
        out.add(url.origin);
    } catch {
      // not an origin
    }
  }
  return out;
}

// MATCHES_PER_DAY: a whole number from 0 (visitors off) to 1000; anything else is the default
export function matchesPerDay(value: string | undefined): number {
  const text = value?.trim() ?? '';
  return /^\d{1,4}$/.test(text) && Number(text) <= 1000 ? Number(text) : DEFAULT_MATCHES_PER_DAY;
}

// A secret as it can be used: trimmed, printable ASCII only (a header can carry nothing else, and
// fetch's error for such a value would hold it); null when unset or unusable
function secret(value: string | undefined): string | null {
  const text = value?.trim() ?? '';
  return /^[\x21-\x7e]+$/.test(text) ? text : null;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    Vary: 'Origin',
  };
}

function json(
  status: number,
  body: unknown,
  origin: string | null,
  extra: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(origin ? corsHeaders(origin) : { Vary: 'Origin' }),
      ...extra,
    },
  });
}

export function createHandler(overrides: Partial<HandlerOptions> = {}) {
  const opts: HandlerOptions = { ...DEFAULT_OPTIONS, ...overrides };
  return {
    async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
      // An Origin header proves nothing (any program can send one): it keeps other websites'
      // pages from using the proxy through their visitors' browsers, no more
      const origin = request.headers.get('Origin');
      if (origin === null || !allowedOrigins(env.ALLOWED_ORIGINS).has(origin))
        return json(403, { error: "requests are only accepted from the demo's site" }, null);
      try {
        return await handle(request, env, opts, origin);
      } catch (err) {
        console.error(`tactical proxy: unexpected ${errorName(err)}`);
        return json(500, { error: 'the proxy failed on this request' }, origin);
      }
    },
  };
}

async function handle(
  request: Request,
  env: Env,
  opts: HandlerOptions,
  origin: string
): Promise<Response> {
  const route = ROUTES.get(new URL(request.url).pathname);
  if (!route) return json(404, { error: 'no such endpoint' }, origin);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': route.method,
        'Access-Control-Allow-Headers': PAGE_HEADERS,
        'Access-Control-Max-Age': PREFLIGHT_MAX_AGE,
        Vary: 'Origin',
      },
    });
  }
  if (request.method !== route.method)
    return json(405, { error: `only ${route.method} is accepted` }, origin, {
      Allow: `${route.method}, OPTIONS`,
    });
  return route.kind === 'status'
    ? status(request, env, opts, origin)
    : forward(request, env, opts, route, origin);
}

// The visitor's counter, or null when the request has no usable address
async function counterFor(request: Request, env: Env, salt: string): Promise<QuotaStub | null> {
  const key = clientKey(request.headers.get('CF-Connecting-IP'));
  if (!key) return null;
  return env.QUOTA.get(env.QUOTA.idFromName(await counterName(salt, key)));
}

function isAuthor(request: Request, env: Env): Promise<boolean> {
  return sameSecret(request.headers.get('x-ai-key'), secret(env.AUTHOR_KEY));
}

// GET /api/tactical: which models the proxy serves and the caller's quota, before a match
async function status(
  request: Request,
  env: Env,
  opts: HandlerOptions,
  origin: string
): Promise<Response> {
  const now = opts.now();
  const perDay = matchesPerDay(env.MATCHES_PER_DAY);
  const models = {
    jev: secret(env.TYPESAFE_API_KEY) !== null,
    snap: secret(env.SUBQ_API_KEY) !== null,
  };
  const whole: QuotaView = {
    matchesPerDay: perDay,
    matchesUsed: 0,
    matchesLeft: perDay,
    resetsAt: resetsAt(now),
  };
  if (await isAuthor(request, env))
    return json(200, { ...models, quota: whole, exempt: true }, origin);
  const salt = secret(env.QUOTA_SALT);
  // Without the salt no visitor's match can be counted, so none is served
  if (salt === null)
    return json(200, { jev: false, snap: false, quota: { ...whole, matchesLeft: 0 } }, origin);
  const counter = await counterFor(request, env, salt);
  if (!counter) return json(403, { error: NO_ADDRESS }, origin);
  let quota: QuotaView;
  try {
    quota = await counter.peek(now, perDay);
  } catch (err) {
    console.error(`tactical proxy: the match counter failed (${errorName(err)})`);
    return json(503, { error: COUNTER_DOWN, retryable: true }, origin);
  }
  return json(200, { ...models, quota }, origin);
}

// POST /api/jev, /api/snap: counted, then passed on to the service
async function forward(
  request: Request,
  env: Env,
  opts: HandlerOptions,
  route: ServiceRoute,
  origin: string
): Promise<Response> {
  const key = secret(env[route.key]);
  if (key === null)
    return json(
      503,
      {
        error: `${route.label} is not available here: the proxy has no usable ${route.service} key`,
        retryable: false,
      },
      origin
    );
  const matchId = request.headers.get('x-match-id');
  if (matchId === null || !MATCH_ID.test(matchId))
    return json(
      400,
      { error: 'x-match-id is missing or malformed (8 to 64 letters, digits, "_" or "-")' },
      origin
    );
  let counter: QuotaStub | null = null;
  if (!(await isAuthor(request, env))) {
    const salt = secret(env.QUOTA_SALT);
    if (salt === null)
      return json(
        503,
        { error: 'the proxy cannot count matches: it is not set up (no salt)', retryable: false },
        origin
      );
    counter = await counterFor(request, env, salt);
    if (!counter) return json(403, { error: NO_ADDRESS }, origin);
  }
  // Read before counting: a body the proxy refuses uses no match
  const body = await readBody(request, JEV_MAX_REQUEST_SIZE);
  if (!body)
    return json(
      413,
      { error: `request too large (over ${JEV_MAX_REQUEST_SIZE} characters)` },
      origin
    );
  let quota: QuotaView | null = null;
  if (counter) {
    let taken: TakeResult;
    try {
      taken = await counter.take(matchId, opts.now(), matchesPerDay(env.MATCHES_PER_DAY));
    } catch (err) {
      // Never passed on uncounted
      console.error(`tactical proxy: the match counter failed (${errorName(err)})`);
      return json(503, { error: COUNTER_DOWN, retryable: true }, origin);
    }
    if (!taken.ok) return refused(taken.reason, taken.quota, origin);
    quota = taken.quota;
  }
  return send(request, route, key, body, opts, origin, quota);
}

// A quota refusal: 403 with x-tactical-quota (the reason), which the page tells apart from other
// refusals; the page stops its tactical layer at once (no retry: 403 is not transient)
function refused(reason: Refusal, quota: QuotaView, origin: string): Response {
  return json(403, { error: refusalText(reason, quota), reason, quota }, origin, {
    'x-tactical-quota': reason,
  });
}

function refusalText(reason: Refusal, quota: QuotaView): string {
  const n = quota.matchesPerDay;
  switch (reason) {
    case 'matches-used':
      return n === 0
        ? 'The tactical layer (Jev, Snap) is turned off for visitors at the moment.'
        : `Your ${n} ${n === 1 ? 'match' : 'matches'} a day with the tactical layer (Jev, Snap) are used for today; they reset at 00:00 UTC.`;
    case 'match-window':
      return `This match has had the tactical layer for ${MATCH_WINDOW_MS / 3_600_000} hours, the most one match may.`;
    case 'match-requests':
      return `This match has made ${MATCH_MAX_REQUESTS} requests to the tactical layer, the most one match may.`;
  }
}

// The body, at most `maxChars` UTF-16 units of text as the browser counts it (body.length,
// JEV_MAX_REQUEST_SIZE), or null when longer. Its bytes are passed on untouched.
async function readBody(
  request: Request,
  maxChars: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  // A text of n UTF-16 units is at most 3n bytes of UTF-8: more bytes are more characters
  const maxBytes = maxChars * 3;
  if (Number(request.headers.get('Content-Length')) > maxBytes) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes).length > maxChars ? null : bytes;
}

// The request to the service, with the key; its answer back without the service's own headers
async function send(
  request: Request,
  route: ServiceRoute,
  key: string,
  body: Uint8Array<ArrayBuffer>,
  opts: HandlerOptions,
  origin: string,
  quota: QuotaView | null
): Promise<Response> {
  // Only what the service needs: the browser's Origin, cookies, referrer, the author's key and
  // its own Authorization stay here
  const headers = new Headers({
    'Content-Type': request.headers.get('Content-Type') ?? 'application/json',
    Authorization: `Bearer ${key}`,
  });
  const accept = request.headers.get('Accept');
  if (accept !== null) headers.set('Accept', accept);
  // The answer's body is read within the same time: a body that stalls is a 504, not a 200 cut
  // short. The page retries 502 and 504 within its own 30 s (JEV_TIMEOUT_MS).
  const signal = AbortSignal.timeout(opts.upstreamTimeoutMs);
  let res: Response;
  let answer: ArrayBuffer | null;
  try {
    res = await fetch(opts.upstream[route.model] + UPSTREAM_PATH, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual', // the key would go with it
      signal,
    });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      void res.body?.cancel().catch(() => undefined);
      return json(
        502,
        { error: `${route.service} answered with a redirect (${res.status})` },
        origin
      );
    }
    answer = NULL_BODY.has(res.status) ? null : await res.arrayBuffer();
  } catch {
    return signal.aborted
      ? json(
          504,
          { error: `${route.service} did not answer within ${opts.upstreamTimeoutMs / 1000} s` },
          origin
        )
      : json(502, { error: `cannot reach ${route.service}` }, origin);
  }
  if (res.status < 200 || res.status > 599)
    return json(502, { error: `${route.service} answered with status ${res.status}` }, origin);
  const out = new Headers({
    ...corsHeaders(origin),
    'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const name of PASSED_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) out.set(name, value);
  }
  if (quota) out.set('x-tactical-matches-left', String(quota.matchesLeft));
  return new Response(answer, { status: res.status, headers: out });
}
