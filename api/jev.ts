// Vercel function: the Jev proxy for the deployed site (D7, D8). Same job as the dev-server
// proxy in vite.config.ts: forward the request to TypeSafe and add the API key on the server,
// so the key never reaches the browser. The key is set in the Vercel project settings
// (environment variable TYPESAFE_API_KEY).

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_BODY_BYTES = 100_000; // a battle request is ~13 KB
const UPSTREAM_TIMEOUT_MS = 25_000; // the browser gives up after 30 s

export async function POST(request: Request): Promise<Response> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return json(500, { error: 'TYPESAFE_API_KEY is not set in the Vercel project' });

  // Only the site itself may use the proxy: the browser sends its Origin with every POST.
  // This does not stop a determined caller, but keeps the key from being used by other sites.
  const origin = request.headers.get('origin');
  if (!origin || !sameHost(origin, request.url)) {
    return json(403, { error: 'requests are only accepted from this site' });
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json(413, { error: 'request too large' });

  // TypeSafe unreachable or silent: say so (the browser counts it and asks again), and answer
  // before the browser gives up at 30 s rather than leaving the function hanging
  let res: Response;
  try {
    res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return timedOut
      ? json(504, { error: `TypeSafe did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} s` })
      : json(502, { error: `cannot reach TypeSafe: ${String(err)}` });
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A malformed Origin (e.g. "null" from a sandboxed page) is refused instead of throwing.
function sameHost(origin: string, url: string): boolean {
  try {
    return new URL(origin).host === new URL(url).host;
  } catch {
    return false;
  }
}
