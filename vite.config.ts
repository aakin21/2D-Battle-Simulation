import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import { execSync } from 'node:child_process';
import { llmPlugin } from './server/llmPlugin';
import { aiAccessPlugin } from './server/aiAccess';

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
      // Server-to-server call: only what the service needs goes on. The browser's Origin (so the
      // service's CORS check never applies), the AI password (x-ai-key, D37), cookies, the
      // referrer and the browser's own Authorization stay here; Authorization is the server's key.
      proxy.on('proxyReq', (proxyReq) => {
        for (const name of proxyReq.getHeaderNames()) {
          if (!PROXY_REQUEST_HEADERS.has(name) && !(key && name === 'authorization'))
            proxyReq.removeHeader(name);
        }
      });
      // The service's cookies and CORS headers are not passed back: the guard's CORS headers
      // (server/aiAccess.ts) are the ones the browser sees.
      proxy.on('proxyRes', (proxyRes) => {
        for (const name of Object.keys(proxyRes.headers)) {
          if (name === 'set-cookie' || name.startsWith('access-control-'))
            delete proxyRes.headers[name];
        }
      });
    },
  });

  return {
    base: './',
    define: { __APP_VERSION__: JSON.stringify(appVersion()) },
    plugins: [aiAccessPlugin(env), llmPlugin(env)],
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
