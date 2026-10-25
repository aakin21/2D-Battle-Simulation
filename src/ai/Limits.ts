// Timeouts and size limits that must agree between the browser and the servers. Shared by the AI
// layers and the dev server (server/llmPlugin.ts, vite.config.ts); api/jev.ts keeps its own
// copies (Vercel bundles it on its own), so change them there too.

// The browser gives up on an LLM request after this long; it then counts as a failure
export const LLM_TIMEOUT_MS = 120_000;
// The dev server gives up on an LLM answer earlier than the browser, so the browser gets the
// reason and the stuck session is closed at once instead of after the browser has given up
export const LLM_SERVER_TIMEOUT_MS = 110_000;
// The browser gives up on a Jev or Snap request after this long
export const JEV_TIMEOUT_MS = 30_000;
// Largest Jev request, far above a normal one (~20–23 KB with three heroes), in characters of
// the JSON text: the browser checks the body it sends, the deployed proxy (api/jev.ts) the text
// it receives, and refuses more
export const JEV_MAX_REQUEST_SIZE = 100_000;
// The Jev and Snap proxies (the dev server's in vite.config.ts and the deployed api/jev.ts, which
// keeps its own copy) give up on the service after this long and answer 504: well inside the
// browser's JEV_TIMEOUT_MS, so the browser gets a status it retries and time for one more try of
// the same length, instead of reaching its own timeout, which stops the layer
export const JEV_PROXY_TIMEOUT_MS = 14_000;
