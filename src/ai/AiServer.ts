// D37: where the AI endpoints (/api/jev, /api/llm) are. With `npm run dev` they are on this
// site. The online demo is a static site without them; it reaches the author's computer
// through a tunnel. The tunnel address and the AI password are given once in the demo's link,
// `?ai=https://xyz.trycloudflare.com&key=PASSWORD`, and this browser remembers them
// (`?ai=` with an empty value forgets them).

const STORE_KEY = 'aiServer';

interface AiServer {
  base: string; // '' = this site
  key: string;
}

const server: AiServer = load();

function load(): AiServer {
  let saved: AiServer = { base: '', key: '' };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const stored = raw ? (JSON.parse(raw) as Partial<Record<keyof AiServer, unknown>>) : null;
    if (stored) saved = { base: serverOrigin(stored.base), key: text(stored.key) };
  } catch {
    // no storage (private window, tests) or damaged: use this site
  }
  try {
    const url = new URL(location.href);
    const base = url.searchParams.get('ai');
    if (base !== null) {
      saved = { base: serverOrigin(base), key: url.searchParams.get('key') ?? '' };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(saved));
      } catch {
        // kept for this page load only
      }
      // Keep the password out of the address bar and the history.
      url.searchParams.delete('ai');
      url.searchParams.delete('key');
      history.replaceState(null, '', url.toString());
    }
  } catch {
    // not in a browser (headless tests)
  }
  return saved;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// The AI server's origin from what the link (or an older saved copy) gives. Without a scheme
// "abc.trycloudflare.com" would be read as a path on this site, and a path after the host
// ("…/api") would double the endpoint's; anything that is not an http(s) address means "this
// site".
export function serverOrigin(value: unknown): string {
  const given = text(value).trim();
  if (!given) return '';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(given);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(given)
    ? given
    : `${local ? 'http' : 'https'}://${given}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

export function aiEndpoint(path: string): string {
  return server.base + path;
}

export function aiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (server.base) {
    if (server.key) headers['x-ai-key'] = server.key;
    headers['ngrok-skip-browser-warning'] = '1'; // ngrok's free tier otherwise answers with a page
  }
  return headers;
}

// The AI server refused the request because the password is wrong or missing (server/aiAccess.ts).
export function deniedByAiServer(res: Response): boolean {
  return res.headers.get('x-ai-access') === 'denied';
}

export const AI_PASSWORD_HINT =
  'Wrong or missing AI password: open the demo with ?ai=<tunnel address>&key=<AI_PASSWORD>.';

export function unreachableHint(): string {
  return server.base
    ? `Cannot reach the AI server at ${server.base}: are npm run dev and the tunnel running?`
    : 'Is the dev server running (npm run dev)?';
}

// Why a request failed, for the AI panel: the AI server's own reason (its endpoints answer with
// { error }) and whether trying again later may help (the LLM endpoint says so with
// `retryable`). A tunnel or proxy page is not JSON and adds nothing.
export async function failureInfo(
  res: Response
): Promise<{ detail: string; retryable: boolean | null }> {
  try {
    const body = (await res.json()) as { error?: unknown; retryable?: unknown } | null;
    return {
      detail: typeof body?.error === 'string' ? `: ${body.error.slice(0, 200)}` : '',
      retryable: typeof body?.retryable === 'boolean' ? body.retryable : null,
    };
  } catch {
    return { detail: '', retryable: null };
  }
}

// Statuses a tunnel (Cloudflare, ngrok) or proxy gives when it cannot reach the AI server, e.g.
// Cloudflare's 530 for a quick-tunnel address that no longer exists (a new one each start).
// Cloudflare uses 520–527 and 530; 529 is TypeSafe's (and Anthropic's) "overloaded".
export function unreachableStatus(status: number): boolean {
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status >= 520 && status <= 527) ||
    status === 530
  );
}

// A layer stops after this many failed requests in a row; fewer are tried again later
export const FAILURES_IN_A_ROW = 3;

// Statuses that may pass on a later try: timeouts, rate limits, overload and server errors
// (TypeSafe's 429 and 529 included). A refusal by the AI server (password) never does.
export function transientStatus(res: Response): boolean {
  return (res.status === 408 || res.status === 429 || res.status >= 500) && !deniedByAiServer(res);
}

// TypeSafe's own SDKs retry 408, 429, 5xx and lost connections twice, after 0.5 s and 1 s with
// up to 25% jitter, honouring Retry-After, within the request's time budget. The same here for
// Jev, whose answers take well under a second. Jitter comes from crypto: Math.random belongs to
// the simulation.
const RETRIES = 2;
const BACKOFF_MS = 500;
const BACKOFF_MAX_MS = 5000;

export async function fetchWithRetries(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit & { signal: AbortSignal }
): Promise<{ res: Response; attempts: number }> {
  for (let attempt = 0; ; attempt++) {
    let wait: number;
    try {
      const res = await fetchFn(url, init);
      if (attempt >= RETRIES || !transientStatus(res)) return { res, attempts: attempt + 1 };
      wait = retryAfterMs(res) ?? backoff(attempt);
    } catch (err) {
      if (init.signal.aborted || attempt >= RETRIES) throw err;
      wait = backoff(attempt);
    }
    await sleep(Math.min(wait, BACKOFF_MAX_MS), init.signal);
  }
}

function backoff(attempt: number): number {
  const jitter = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return BACKOFF_MS * 2 ** attempt * (1 - 0.25 * jitter);
}

function retryAfterMs(res: Response): number | null {
  const ms = Number(res.headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(res.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

// Resolves after ms, or rejects at once when the request is aborted (timeout, restart)
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}
