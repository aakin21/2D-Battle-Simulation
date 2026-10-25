import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import { execSync } from 'node:child_process';
import { ServerResponse, type ClientRequest, type IncomingMessage } from 'node:http';
import { llmPlugin } from './server/llmPlugin';
import { aiAccessPlugin } from './server/aiAccess';
import { JEV_PROXY_TIMEOUT_MS } from './src/ai/Limits';

// Code version written into match logs, so every experiment can be traced to its commit.
function appVersion(): string {
  try {
    return execSync('git describe --tags --always --dirty', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// The request headers the decision-model proxies forward (host is the service's, changeOrigin)
const PROXY_REQUEST_HEADERS = new Set([
  'host',
  'content-type',
  'content-length',
  'transfer-encoding',
  'accept',
]);
// The service's response headers that do not reach the browser: its cookies, its CORS headers
// (the guard's, server/aiAccess.ts, are the ones the browser sees), a redirect's target and its
// Vary (the guard's Vary: Origin stays)
const dropResponseHeader = (name: string) =>
  name === 'set-cookie' ||
  name === 'location' ||
  name === 'vary' ||
  name.startsWith('access-control-');
// The decision-model proxies' paths (Vite's proxy matches the start of the URL)
const DECISION_PROXY_PATHS = ['/api/jev', '/api/snap'];

// What the browser sees of a request the proxy cannot complete
function proxyFailure(res: ServerResponse, status: number, error: string): void {
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.destroy(); // the answer had begun: it is cut, and the browser sees a failed request
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

// The decision models take POST only: another method is answered here, never proxied
function decisionProxyMethods(): Plugin {
  return {
    name: 'decision-proxy-methods',
    configureServer(server) {
      // Added directly, so it runs after the guard (server/aiAccess.ts) and before Vite's proxy
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url ?? '';
        if (req.method === 'POST' || !DECISION_PROXY_PATHS.some((p) => url.startsWith(p)))
          return next();
        res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'only POST is accepted' }));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // TYPESAFE_API_KEY, SUBQ_API_KEY and OPENROUTER_API_KEY come from .env.local (not
  // committed). They are added here, on the dev server, so no key reaches the browser (D7, P1).
  const env = loadEnv(mode, process.cwd(), '');
  // A decision-model proxy: Jev (TypeSafe) and SubQ Snap (D51) take the same request at the
  // same path
  const decisionProxy = (target: string, key: string | undefined): ProxyOptions => ({
    target,
    changeOrigin: true,
    rewrite: () => '/v1/systemone',
    headers: key ? { Authorization: `Bearer ${key}` } : ({} as Record<string, string>),
    configure: (proxy) => {
      const outgoing = new WeakMap<IncomingMessage, ClientRequest>();
      // Server-to-server call: only what the service needs goes on. The browser's Origin (so the
      // service's CORS check never applies), the AI password (x-ai-key, D37), cookies, the
      // referrer and the browser's own Authorization stay here; Authorization is the server's key.
      // Removed from the request before the proxy copies its headers ('start' comes first): the
      // proxy skips its 'proxyReq' event for a request with an Expect header.
      proxy.on('start', (req, res) => {
        for (const name of Object.keys(req.headers)) {
          if (!PROXY_REQUEST_HEADERS.has(name)) delete req.headers[name];
        }
        // A silent service ends as a 504 the browser retries, before the browser's own timeout
        // (JEV_TIMEOUT_MS), as api/jev.ts does on Vercel
        if (!(res instanceof ServerResponse)) return;
        const timer = setTimeout(() => {
          proxyFailure(
            res,
            504,
            `the service did not answer within ${JEV_PROXY_TIMEOUT_MS / 1000} s`
          );
          outgoing.get(req)?.destroy();
        }, JEV_PROXY_TIMEOUT_MS);
        res.on('close', () => clearTimeout(timer));
      });
      proxy.on('proxyReq', (proxyReq, req) => {
        outgoing.set(req, proxyReq);
        // Checked again on the request that goes out
        for (const name of proxyReq.getHeaderNames()) {
          if (!PROXY_REQUEST_HEADERS.has(name) && !(key && name === 'authorization'))
            proxyReq.removeHeader(name);
        }
      });
      proxy.on('proxyRes', (proxyRes) => {
        for (const name of Object.keys(proxyRes.headers)) {
          if (dropResponseHeader(name)) delete proxyRes.headers[name];
        }
        // A redirect is not followed and not passed on: the service answered wrongly
        const status = proxyRes.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          proxyRes.statusCode = 502;
          proxyRes.statusMessage = 'Bad Gateway';
        }
      });
      // Runs before Vite's own handler, which then only logs: the service unreachable, or the
      // request cut by the timeout above (the answer is already sent then)
      proxy.on('error', (_err, _req, res) => {
        if (res instanceof ServerResponse) proxyFailure(res, 502, 'cannot reach the service');
      });
    },
  });

  return {
    base: './',
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    plugins: [aiAccessPlugin(env), llmPlugin(env), decisionProxyMethods()],
    build: {
      outDir: 'dist',
    },
    server: {
      // D37: the online demo reaches /api/* through a tunnel; these are the tunnel host names.
      // Requests through them need the AI password (server/aiAccess.ts).
      allowedHosts: ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.app', '.ngrok.io'],
      // Vite 5's default deny list plus the repository's .git (Vite 6 adds it; setting the
      // option replaces the default, so the default entries are repeated here)
      fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'] },
      proxy: {
        '/api/jev': decisionProxy('https://api.typesafe.ai', env.TYPESAFE_API_KEY),
        '/api/snap': decisionProxy('https://api.subq.ai', env.SUBQ_API_KEY),
      },
    },
  };
});
