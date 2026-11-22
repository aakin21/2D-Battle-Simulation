// Connecting OpenRouter (the title screen's AI connections, or Connect… in Match setup): a
// visitor of the static site, which has no AI server, plays with an LLM on their own OpenRouter
// account. OpenRouter's OAuth PKCE flow
// (https://openrouter.ai/docs/use-cases/oauth-pkce): the page goes to openrouter.ai, the visitor
// allows a key of their account, OpenRouter sends them back with a one-time code, and this page
// trades the code (with the verifier only it knows) for the key. No server of ours takes part.
//
// The key lives in this module's memory only: OpenRouter says it must not be kept in
// localStorage, sessionStorage, IndexedDB or a cookie scripts can read, so it is gone after a
// reload and the visitor connects again. It is used in one place, the Authorization header of a
// request to OPENROUTER_ORIGIN (openRouterFetch); nothing else can read it, and no message, log
// or console line contains it. sessionStorage holds only what the round trip needs (the verifier,
// the state and the menu's choices) from leaving for openrouter.ai until coming back.
//
// Never Math.random: the simulation draws from it. The values come from crypto.getRandomValues.

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
const AUTH_PAGE = `${OPENROUTER_ORIGIN}/auth`;
const KEYS_URL = `${OPENROUTER_ORIGIN}/api/v1/auth/keys`;

// What the new key is offered with on OpenRouter's page (the visitor can change both there): a
// credit limit of $5, the AI server's LLM_MAX_BUDGET_USD default, and an end after a day, since
// this page forgets the key at the next reload and every connect makes a new one on the account
export const KEY_LIMIT_USD = 5;
export const KEY_EXPIRATION = '1-day';
// The name the key gets on the visitor's account (they can change it), so they can find it there
export const KEY_LABEL = '2D Battle Simulation';

// sessionStorage, from leaving for openrouter.ai until coming back
export const PENDING_KEY = 'openrouterConnect';
const EXCHANGE_TIMEOUT_MS = 30_000;
// The most of OpenRouter's own error text that goes into a message
const MAX_DETAIL = 300;
// A key as OpenRouter gives it goes into a header: printable ASCII, nothing a header cannot carry
const KEY_FORMAT = /^[\x21-\x7e]{1,1000}$/;

export type ConnectStatus = 'not-connected' | 'connecting' | 'connected';

let key: string | null = null;
let status: ConnectStatus = 'not-connected';
let message = ''; // why the last connect did not work, until the next try or Disconnect
const listeners = new Set<() => void>();

// The connection as the menu shows it
export function connection(): { status: ConnectStatus; message: string } {
  return { status, message };
}

export function openRouterConnected(): boolean {
  return key !== null;
}

// Called whenever the status or the message changes
export function onConnectionChange(listener: () => void): void {
  listeners.add(listener);
}

function set(next: ConnectStatus, text: string): void {
  status = next;
  message = text;
  for (const listener of listeners) listener();
}

// Forgets the key. It stays valid on OpenRouter until it ends (KEY_EXPIRATION) or the visitor
// deletes it there: a key cannot delete itself.
export function disconnectOpenRouter(): void {
  key = null;
  set('not-connected', '');
}

const capped = (text: string): string =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A text without the key in it: a service that echoed the Authorization header in an error would
// otherwise put it into the panels, the match log and replays. Masked before any text is cut, so
// no part of the key is left at a cut.
export function withoutKey(text: string): string {
  return key === null ? text : text.split(key).join('…');
}

// OpenRouter's error text from an error body ({ error: { message } }, or { error: "…" }), without
// the key, cut to MAX_DETAIL characters
export function errorDetail(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  const text =
    typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown } | null)?.message === 'string'
        ? (error as { message: string }).message
        : '';
  return capped(withoutKey(text));
}

// --- PKCE (RFC 7636) ---

export function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 32 random bytes as base64url: 43 characters of A–Z a–z 0–9 - _ (RFC 7636 asks for 43–128 of
// its unreserved characters; OpenRouter's own example does the same)
export function randomVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

// The S256 challenge: base64url(SHA-256(verifier))
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// Where OpenRouter sends the visitor back: this page without its query and fragment. OpenRouter
// takes an https address, or http on localhost; any other page cannot connect.
export function callbackUrl(href: string): string | null {
  try {
    const url = new URL(href);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

export function authUrl(callback: string, challenge: string, state: string): string {
  const url = new URL(AUTH_PAGE);
  url.searchParams.set('callback_url', callback);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('limit', String(KEY_LIMIT_USD));
  url.searchParams.set('key_label', KEY_LABEL);
  url.searchParams.set('expiration', KEY_EXPIRATION);
  return url.href;
}

// --- Leaving for openrouter.ai ---

interface Pending {
  verifier: string;
  state: string;
  menu: unknown;
}

const AGAIN = 'Press Connect (OpenRouter, in AI connections) to try again.';

// Starts connecting: the page goes to openrouter.ai, with `menu` (the menu's choices) kept for
// when it comes back. When it cannot start, the reason is the connection's message and false is
// returned. `go` opens the address (tests pass their own).
export async function startConnect(
  menu: unknown,
  go: (url: string) => void = (url) => location.assign(url)
): Promise<boolean> {
  if (status === 'connecting') return false;
  const callback = callbackUrl(typeof location === 'undefined' ? '' : location.href);
  if (!callback) {
    set(
      status,
      'Connecting needs this page on https:// (or on localhost): OpenRouter sends the code for the key back to it.'
    );
    return false;
  }
  const verifier = randomVerifier();
  const state = randomVerifier();
  let challenge: string;
  try {
    challenge = await codeChallenge(verifier);
  } catch {
    set(status, 'This browser cannot compute the code OpenRouter asks for (no Web Crypto here).');
    return false;
  }
  const pending: Pending = { verifier, state, menu };
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    if (sessionStorage.getItem(PENDING_KEY) === null) throw new Error('not kept');
  } catch {
    set(
      status,
      "Connecting needs this tab's session storage, which the browser does not allow here; allow site data for this page and try again."
    );
    return false;
  }
  go(authUrl(callback, challenge, state));
  return true;
}

// The round trip's record, read once and removed at once (null when there is none or it cannot
// be read)
function takePending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(PENDING_KEY);
    const p = JSON.parse(raw) as Partial<Record<keyof Pending, unknown>> | null;
    if (!p || typeof p.verifier !== 'string' || typeof p.state !== 'string') return null;
    return { verifier: p.verifier, state: p.state, menu: p.menu ?? null };
  } catch {
    return null;
  }
}

// --- Coming back ---

// Called once when the page loads. When the page comes back from openrouter.ai (or was left for
// it and loaded again without an answer), the code and state leave the address bar and the
// history at once, the round trip's record leaves sessionStorage, and the code is traded for the
// key (the connection says how it went). Returns the menu's choices kept for the trip (null when
// there are none), or null when this load has nothing to do with connecting.
export function completeConnect(): { menu: unknown } | null {
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return null; // not in a browser
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const pending = takePending();
  if (code === null && error === null && !pending) return null;
  if (code !== null || state !== null || error !== null) {
    for (const name of ['code', 'state', 'error']) url.searchParams.delete(name);
    try {
      history.replaceState(history.state, '', url.href);
    } catch {
      // not in a browser
    }
  }
  const menu = pending?.menu ?? null;
  if (code === null) {
    set(
      'not-connected',
      error !== null
        ? `OpenRouter did not connect (${error.slice(0, 80)}). ${AGAIN}`
        : `Connecting with OpenRouter did not finish (cancelled, or the page was left before allowing it). ${AGAIN}`
    );
    return { menu };
  }
  if (!pending) {
    set(
      'not-connected',
      `OpenRouter sent a code this tab did not ask for (or the tab's session storage was cleared or blocked); nothing was connected. ${AGAIN}`
    );
    return { menu };
  }
  if (state !== pending.state) {
    set(
      'not-connected',
      `OpenRouter's answer does not belong to this tab's request (the state differs); nothing was connected. ${AGAIN}`
    );
    return { menu };
  }
  void exchange(code, pending.verifier);
  return { menu };
}

// Trades the code for the key (POST /api/v1/auth/keys). The code works once and for 10 minutes.
async function exchange(code: string, verifier: string): Promise<void> {
  set('connecting', '');
  const fail = (text: string) => set('not-connected', `${text} ${AGAIN}`);
  let res: Response;
  try {
    res = await fetch(KEYS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      redirect: 'manual', // never followed: the code and the verifier would go wherever it points
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (err) {
    return fail(`Could not reach OpenRouter to finish connecting (${capped(errorText(err))}).`);
  }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    res.body?.cancel().catch(() => undefined);
    return fail(
      'OpenRouter answered with a redirect, which is not followed; nothing was connected.'
    );
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = errorDetail(body);
    return fail(
      res.status === 403
        ? `OpenRouter refused the code (HTTP 403${detail ? `: ${detail}` : ''}): it works once and for 10 minutes.`
        : `OpenRouter could not finish connecting (HTTP ${res.status}${detail ? `: ${detail}` : ''}).`
    );
  }
  const given = (body as { key?: unknown } | null)?.key;
  if (typeof given !== 'string' || !KEY_FORMAT.test(given))
    return fail("OpenRouter's answer had no usable key; nothing was connected.");
  key = given;
  set('connected', '');
}

// --- Using the key ---

// A POST to OpenRouter's API with the key, or null when the page is not connected. The address is
// always OPENROUTER_ORIGIN; a redirect is never followed (the caller sees it), no cookie and no
// referrer go with it, and no header names this site (no HTTP-Referer or X-Title). fetch's own
// error text cannot hold the key (it was checked when it came), and it is masked anyway.
export async function openRouterFetch(
  path: `/api/v1/${string}`,
  body: string,
  signal?: AbortSignal
): Promise<Response | null> {
  const k = key;
  if (k === null) return null;
  try {
    return await fetch(OPENROUTER_ORIGIN + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
      body,
      signal,
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  } catch (err) {
    if (signal?.aborted) throw err; // the request's timeout or the end of the match
    throw new Error(withoutKey(errorText(err)));
  }
}
