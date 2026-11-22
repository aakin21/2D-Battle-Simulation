import type { QueryFn } from './claudeSession';

// The Claude models on the AI bridge (bridge.ts), through the Agent SDK as on the dev server: with
// the player's ANTHROPIC_API_KEY when it is set (billed to the key's account), otherwise on the
// Claude Code sign-in of the person running the bridge, as the dev server runs on the author's
// (D9, D10). Anthropic's documentation says third-party developers may not offer claude.ai login
// or its rate limits in their products, Agent SDK agents included, without approval, and asks for
// API key authentication (code.claude.com/docs/en/agent-sdk/overview,
// code.claude.com/docs/en/legal-and-compliance.md); using one's own sign-in through the bridge is
// the player's judgement, and the README says so. The bridge never reads, stores or passes on a
// Claude credential itself: the Claude Code program the SDK starts finds its own sign-in.

export const CLAUDE_BAD_KEY =
  'ANTHROPIC_API_KEY has characters a header cannot carry (a line break or a pasted quote?); fix it and restart the bridge.';
export const SDK_MISSING =
  'Claude models need the Claude Agent SDK, which could not be loaded where the bridge runs: start the bridge with npx (it installs the SDK) or from a clone of the repository (npm install, then npm run bridge).';

// Credentials Claude Code would choose before ANTHROPIC_API_KEY, and its claude.ai token: its
// authentication precedence is a cloud provider (CLAUDE_CODE_USE_*), ANTHROPIC_AUTH_TOKEN, then
// ANTHROPIC_API_KEY (always used when present in non-interactive mode), and later
// CLAUDE_CODE_OAUTH_TOKEN and the /login subscription (code.claude.com/docs/en/authentication, read
// 2026-11-21). With the key set, none of them reaches the Claude Code process, so the key is the
// credential it uses.
const RANKED_ABOVE_KEY = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];
// The bridge's other keys and the project's: never in the Claude Code process's environment
const OTHER_KEYS = [
  'OPENROUTER_API_KEY',
  'LOCAL_LLM_KEY',
  'GEMINI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'TYPESAFE_API_KEY',
  'SUBQ_API_KEY',
  'AI_PASSWORD',
];

// How the Claude models run on the bridge: with the API key, on the sign-in, or why they are off
export function claudeWay(
  sdkQuery: QueryFn | null,
  key: string | undefined
): 'key' | 'sign-in' | string {
  const k = (key ?? '').trim();
  if (!sdkQuery) return SDK_MISSING;
  if (k && !/^[\x21-\x7e]+$/.test(k)) return CLAUDE_BAD_KEY;
  return k ? 'key' : 'sign-in';
}

// What runs the Claude models on the bridge: the SDK's query() with the environment the Claude
// Code process gets, or why they are off (a request for one gets that text as a 500, not
// retryable; GET /api/bridge says claude: false)
export function bridgeClaude(sdkQuery: QueryFn | null, key: string | undefined): QueryFn | string {
  const way = claudeWay(sdkQuery, key);
  if (way !== 'key' && way !== 'sign-in') return way;
  return withEnvironment(sdkQuery!, way === 'key' ? (key ?? '').trim() : null);
}

// query() with the bridge's other keys out of the Claude Code process's environment; with the API
// key, the key in and the credentials ranked above it out
function withEnvironment(sdkQuery: QueryFn, key: string | null): QueryFn {
  return (params) => {
    // ClaudeSession passes the whole environment it wants (the SDK does not merge it)
    const env: Record<string, string | undefined> = { ...(params.options?.env ?? process.env) };
    for (const name of OTHER_KEYS) delete env[name];
    if (key) {
      for (const name of RANKED_ABOVE_KEY) delete env[name];
      env.ANTHROPIC_API_KEY = key;
    } else delete env.ANTHROPIC_API_KEY; // only spaces: no key
    return sdkQuery({ ...params, options: { ...params.options, env } });
  };
}
