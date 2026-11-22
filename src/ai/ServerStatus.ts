// What the page's own AI server runs (npm run dev, or the author's dev server through a tunnel,
// D37): GET <AI server>/api/bridge, which the dev server answers in the AI bridge's status shape
// (server/llmPlugin.ts, with `bridge: false`), read field by field as the bridge's is (readRuns).
// Match setup asks it once per page load, when it first opens: a request to this site or to the
// tunnel, never to a server on this computer (the AI bridge is asked only from a click,
// BridgeConnect.ts), so no user gesture is needed. Until it has answered, or when it cannot (an
// older dev server, the tunnel down), Match setup offers the AI server's models as it did without
// it. Nothing of it goes into the match log.

import { aiEndpoint, aiHeaders, aiServerKind, withAddressSpace } from './AiServer';
import { readRuns, statusBody, type ServerRuns } from './BridgeConnect';

export type ServerStatusState = 'not-asked' | 'asking' | 'known' | 'failed';

export const SERVER_STATUS_TIMEOUT_MS = 10_000;

let state: ServerStatusState = 'not-asked';
let runs: ServerRuns | null = null;
let detail = ''; // why it failed
const listeners = new Set<() => void>();

export function serverStatus(): {
  state: ServerStatusState;
  runs: ServerRuns | null;
  detail: string;
} {
  return { state, runs, detail };
}

// What the page's own AI server runs, or null while that is not known
export function serverRuns(): ServerRuns | null {
  return state === 'known' ? runs : null;
}

export function onServerStatusChange(listener: () => void): void {
  listeners.add(listener);
}

function set(next: ServerStatusState, nextRuns: ServerRuns | null, text: string): void {
  state = next;
  runs = nextRuns;
  detail = text;
  for (const listener of listeners) listener();
}

// Asks the page's own AI server, once (later calls do nothing). The caller asks only when the
// page has one (Connections.ownAiServer); a bridge is never asked here. `fetchFn` is for tests.
export async function askServerStatus(
  fetchFn: typeof fetch = (...args) => fetch(...args)
): Promise<void> {
  if (state !== 'not-asked' || aiServerKind() === 'bridge') return;
  const url = aiEndpoint('/api/bridge');
  // The AI password and ngrok's header for a tunnel (aiHeaders); no Content-Type on a GET
  const headers = aiHeaders();
  delete headers['Content-Type'];
  set('asking', null, '');
  try {
    const res = await fetchFn(
      url,
      withAddressSpace(url, {
        method: 'GET',
        headers,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'manual', // a redirect is not the AI server: never followed
        signal: AbortSignal.timeout(SERVER_STATUS_TIMEOUT_MS),
      })
    );
    const body = await statusBody(res, 'the AI server’s status');
    if (typeof body === 'string') return set('failed', null, body);
    const llm = (body as { llm?: unknown }).llm;
    if (!llm || typeof llm !== 'object') return set('failed', null, 'it gave no status');
    set('known', readRuns(llm), '');
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    set(
      'failed',
      null,
      timedOut ? `no answer within ${SERVER_STATUS_TIMEOUT_MS / 1000} s` : 'not reached'
    );
  }
}
