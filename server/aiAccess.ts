import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

// D37: the online demo reaches the AI endpoints (/api/jev, /api/llm) of this dev server through
// a tunnel (ngrok or Cloudflare Tunnel). Requests from this computer (localhost) work as before.
// Every other request must carry the password from AI_PASSWORD in the x-ai-key header, so a
// public tunnel address cannot spend the author's Jev quota or Claude subscription. The demo's
// origin (AI_ALLOWED_ORIGINS) may call the endpoints from another site (CORS).

const DEFAULT_ORIGINS = ['https://aakin21.github.io'];

export function aiAccessPlugin(env: Record<string, string>): Plugin {
  const password = env.AI_PASSWORD ?? '';
  const origins = (env.AI_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const allowed = new Set(origins.length > 0 ? origins : DEFAULT_ORIGINS);

  return {
    name: 'ai-access',
    configureServer(server) {
      // Added directly (not returned), so it runs before Vite's proxy and the LLM endpoint.
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!isApiPath(req.url)) return next();

        const origin = req.headers.origin;
        if (origin && allowed.has(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, x-ai-key, ngrok-skip-browser-warning'
          );
          res.setHeader('Access-Control-Expose-Headers', 'x-ai-access');
        }
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          return res.end();
        }

        // Any website open in this computer's browser can send a simple POST (no preflight)
        // to localhost, which would pass as local and spend the quota. Browsers mark such
        // requests with the site's Origin: only this app and the demo's origin may call.
        if (origin && !allowed.has(origin) && !sameOrigin(origin, req)) {
          return deny(res, 403, 'requests from other sites are refused');
        }

        if (isLocal(req)) return next();
        if (!password) return deny(res, 503, 'AI_PASSWORD is not set on the AI server');
        if (!matches(req.headers['x-ai-key'], password)) return deny(res, 401, 'wrong AI password');
        next();
      });
    },
  };
}

// The path as Vite's middleware routes see it: they match ignoring case ("/API/llm" reaches the
// LLM endpoint) and read the path out of an absolute request target ("POST http://host/api/llm"),
// so both must count here, or they would skip the password. Anything unreadable is checked.
function isApiPath(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url, 'http://localhost').pathname.toLowerCase().startsWith('/api/');
  } catch {
    return true;
  }
}

// Requests made on this computer. A tunnel forwards to localhost too, but keeps the public
// host name in the Host header, so tunnelled requests are never treated as local.
function isLocal(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// The page making the request is served by this server (the app itself, locally or through
// the tunnel). A malformed Origin ("null" from a sandboxed page) is not.
function sameOrigin(origin: string, req: IncomingMessage): boolean {
  try {
    return new URL(origin).host === (req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

function matches(given: string | string[] | undefined, password: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

// x-ai-access tells the browser the refusal came from here, not from TypeSafe or the LLM.
function deny(res: ServerResponse, status: number, error: string): void {
  res.statusCode = status;
  res.setHeader('x-ai-access', 'denied');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error }));
}
