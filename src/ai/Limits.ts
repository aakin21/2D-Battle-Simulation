// Timeouts and size limits that must agree between the browser and the servers. Shared by the AI
// layers and the dev server (server/llmPlugin.ts); api/jev.ts keeps its own copies (Vercel
// bundles it on its own), so change them there too.

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
