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
    if (raw) saved = { ...saved, ...(JSON.parse(raw) as Partial<AiServer>) };
  } catch {
    // no storage (private window, tests): use this site
  }
  try {
    const url = new URL(location.href);
    const base = url.searchParams.get('ai');
    if (base !== null) {
      saved = { base: base.trim().replace(/\/+$/, ''), key: url.searchParams.get('key') ?? '' };
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

// The AI server's own reason for an error status (its endpoints answer with { error }), so the
// AI panel can show it. A tunnel or proxy page is not JSON and adds nothing.
export async function failureDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (typeof body?.error === 'string') return `: ${body.error.slice(0, 200)}`;
  } catch {
    // not JSON
  }
  return '';
}

// Statuses a tunnel (Cloudflare, ngrok) or proxy gives when it cannot reach the AI server, e.g.
// Cloudflare's 530 for a quick-tunnel address that no longer exists (a new one each start).
export function unreachableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}
