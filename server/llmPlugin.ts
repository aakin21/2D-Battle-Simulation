import type { Plugin } from 'vite';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { llmEndpoint, refuseBody, send, type LlmEndpoint } from './llmEndpoint';
import { DEV_SERVER } from './chatSession';
import { BRIDGE_VERSION, llmStatus, type BridgeStatus } from './bridge';

// The dev server's POST /api/llm (D10): the endpoint of llmEndpoint.ts, with the Agent SDK this
// repository installs (Codex runs through the Codex CLI installed on the computer). The AI bridge
// (bridge.ts) serves the same endpoint without Vite.
export function devLlmEndpoint(env: Record<string, string> = {}): LlmEndpoint {
  return llmEndpoint(env, { query });
}

export function llmPlugin(
  env: Record<string, string> = {},
  endpoint: LlmEndpoint = devLlmEndpoint(env)
): Plugin {
  return {
    name: 'battle-llm',
    configureServer(server) {
      server.middlewares.use('/api/llm', endpoint.handle);
      server.httpServer?.on('close', endpoint.close);
    },
  };
}

// The dev server's GET /api/bridge: what its /api/llm runs, in the AI bridge's status shape with
// `bridge: false` (it is not the bridge: the page's "This computer" never takes it for one), so
// Match setup offers the same choices on the page it serves (src/ai/ServerStatus.ts). Behind the
// access guard as every /api/ path (aiAccess.ts: a tunnel needs AI_PASSWORD). The settings are
// read as llmEndpoint reads them (the env Vite loads, then the process's own); never a secret.
export function llmStatusPlugin(env: Record<string, string>, endpoint: LlmEndpoint): Plugin {
  const runs = llmStatus({ ...process.env, ...env }, endpoint, true, DEV_SERVER);
  return {
    name: 'battle-llm-status',
    configureServer(server) {
      server.middlewares.use('/api/bridge', (req, res) => {
        // The mount path is taken off: "/" (or "/?…") is /api/bridge itself, as the bridge's paths
        const rest = req.url ?? '/';
        if (rest !== '/' && !rest.startsWith('/?')) return refuseBody(req, res, 404, 'not found');
        if (req.method !== 'GET') return refuseBody(req, res, 405, 'GET only', { Allow: 'GET' });
        res.setHeader('X-Content-Type-Options', 'nosniff');
        runs().then(
          (llm) => {
            const status: BridgeStatus = { bridge: false, version: BRIDGE_VERSION, llm };
            res.setHeader('Cache-Control', 'no-store');
            send(res, 200, status);
          },
          () => send(res, 500, { error: 'the status could not be read' })
        );
      });
    },
  };
}
