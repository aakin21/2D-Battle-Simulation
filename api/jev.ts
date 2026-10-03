// Vercel function: the Jev proxy for the deployed site (D7, D8). Same job as the dev-server
// proxy in vite.config.ts: forward the request to TypeSafe and add the API key on the server,
// so the key never reaches the browser. The key is set in the Vercel project settings
// (environment variable TYPESAFE_API_KEY).

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const MAX_BODY_BYTES = 100_000; // a battle request is ~13 KB

export async function POST(request: Request): Promise<Response> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return json(500, { error: 'TYPESAFE_API_KEY is not set in the Vercel project' });

  // Only the site itself may use the proxy: the browser sends its Origin with every POST.
  // This does not stop a determined caller, but keeps the key from being used by other sites.
  const origin = request.headers.get('origin');
  if (!origin || new URL(origin).host !== new URL(request.url).host) {
    return json(403, { error: 'requests are only accepted from this site' });
  }

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json(413, { error: 'request too large' });

  const res = await fetch(TYPESAFE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body,
  });
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
