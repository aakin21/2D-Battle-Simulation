// Connecting the AI bridge (the title screen's AI connections, "This computer", or Connect… in
// Match setup): the AI bridge (server/bridge.ts, npm run bridge) serves the LLM endpoint on the
// player's own computer, so the published static demo can run their own model. A click asks the
// bridge what it can run (GET <bridge>/api/bridge); reached, the bridge becomes the page's AI
// server (AiServer.rememberBridge, remembered by this browser as a ?ai= link is) and the menu
// shows what it runs. Disconnect forgets it: the page is back to this site's own endpoints.
//
// Chrome's Local Network Access: the request carries `targetAddressSpace: 'loopback'`
// (withAddressSpace) and is made at once in the click, so the browser's question comes from the
// user's own action. A failed request is told apart with the permission's state
// (loopbackPermission): blocked in the site settings, or not reached.
//
// At page load (connectAtLoad), a bridge this page already knows (the ?ai= link the bridge opens,
// or one remembered) is asked at once only when no question can come of it: the permission is
// granted, or the browser has no such permission at all (loopbackPermissionState 'unsupported').
// Its state 'prompt' sends nothing: the card invites one click (`invited`), which connects and
// lets the browser ask once; 'denied' says how to allow it again, without a request.
//
// The answer is another program's text: only its booleans, an http(s) origin, the model names that
// pass Models.isLocalModelName, the command ids that pass Models.cliToolOf and Codex's reason (cut,
// control characters removed) are kept, and the menu shows them as text. A bridge before 1.1.0 has
// no `codex`, `gemini` or `custom`: those are null ("it does not say"). The page's own AI server
// answers the same status (ServerStatus.ts reads it with readRuns). Nothing of it goes into the
// match log.

import {
  aiServerKind,
  bridgeAddress,
  forgetAiServer,
  loopbackPermission,
  loopbackPermissionState,
  rememberBridge,
  withAddressSpace,
} from './AiServer';
import { cliToolOf, isLocalModelName, modelLabel } from './Models';

export type BridgeState = 'not-connected' | 'connecting' | 'connected' | 'unreachable' | 'denied';

// A command of the AI server's own settings (CLI_TOOL_<NAME>): its model id "cli:<name>", its
// label from Models.modelLabel (never the server's text) and whether its program was found
export interface CustomCommand {
  id: string;
  label: string;
  available: boolean;
}

// What an AI server says it can run (GET /api/bridge's `llm`), field by field
export interface ServerRuns {
  claude: boolean; // the Claude models through the Agent SDK (the Claude Code sign-in there, or its key)
  // OpenAI's Codex through its SDK, or why not (reason '' when it gives none); null: not said
  codex: { available: boolean; reason: string } | null;
  gemini: boolean | null; // Gemini with the server's GEMINI_API_KEY; null: not said
  openrouter: boolean; // OpenRouter models on the server's own OPENROUTER_API_KEY
  localUrl: string | null; // the local model server's origin; null: LOCAL_LLM_URL cannot work
  models: string[] | null; // the local server's models; null: it did not list them
  custom: CustomCommand[] | null; // commands of its settings; null: not said
  rejected: string[]; // names and command ids that cannot be one, left out (cut, for the menu)
}

// What a reached bridge can run
export interface BridgeInfo extends ServerRuns {
  address: string; // http://127.0.0.1:<port>
}

// The browser's question may be open while the request waits
export const BRIDGE_STATUS_TIMEOUT_MS = 30_000;
const MAX_STATUS_BYTES = 1_000_000;
const MAX_MODELS = 200; // as many as the bridge lists
const MAX_COMMANDS = 50;
const MAX_REJECTED_SHOWN = 60; // characters of a refused name kept for the menu
const MAX_REASON = 300; // characters of Codex's reason kept for the menu

let state: BridgeState = 'not-connected';
let info: BridgeInfo | null = null;
let detail = ''; // why the last try did not connect, until the next one
let attempt = 0; // a newer try or Disconnect drops an older try's answer
// The page loaded with a bridge address while the browser would ask: one click connects
let invited = false;
const listeners = new Set<() => void>();

export function bridgeConnection(): {
  state: BridgeState;
  info: BridgeInfo | null;
  detail: string;
  address: string;
  invited: boolean;
} {
  return {
    state,
    info,
    detail,
    address: bridgeAddress(),
    invited: invited && state === 'not-connected',
  };
}

// What the connected bridge runs, or null when this page has not reached one since it loaded
export function bridgeConnected(): BridgeInfo | null {
  return state === 'connected' ? info : null;
}

// Called whenever the state changes
export function onBridgeChange(listener: () => void): void {
  listeners.add(listener);
}

function set(next: BridgeState, nextInfo: BridgeInfo | null, text: string): void {
  state = next;
  info = nextInfo;
  detail = text;
  for (const listener of listeners) listener();
}

// Asks the bridge (this page's bridge address, or the default port on 127.0.0.1) what it can run.
// Call it from the click: the request is made before anything else, so the browser's Local
// Network Access question belongs to that click. `fetchFn` is for tests.
export function connectBridge(fetchFn: typeof fetch = (...args) => fetch(...args)): Promise<void> {
  if (state === 'connecting') return Promise.resolve();
  invited = false;
  const address = bridgeAddress();
  const url = `${address}/api/bridge`;
  const mine = ++attempt;
  let request: Promise<Response>;
  try {
    request = fetchFn(
      url,
      withAddressSpace(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'manual', // a redirect is not the bridge: never followed
        signal: AbortSignal.timeout(BRIDGE_STATUS_TIMEOUT_MS),
      })
    );
  } catch (err) {
    request = Promise.reject(err);
  }
  set('connecting', null, '');
  return finish(mine, address, request);
}

async function finish(mine: number, address: string, request: Promise<Response>): Promise<void> {
  let res: Response;
  try {
    res = await request;
  } catch (err) {
    if (mine !== attempt) return;
    // Refused by the browser's setting, or nothing answering there (not started, another port)
    const permission = await loopbackPermission();
    if (mine !== attempt) return;
    if (permission === 'denied') return set('denied', null, '');
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    return set(
      'unreachable',
      null,
      timedOut ? `no answer within ${BRIDGE_STATUS_TIMEOUT_MS / 1000} s` : ''
    );
  }
  const read = await readStatus(res, address);
  if (mine !== attempt) return;
  if (typeof read === 'string') return set('unreachable', null, read);
  if (!rememberBridge(address)) return set('unreachable', null, 'not an AI bridge address');
  set('connected', read, '');
}

// At page load: a bridge address this page has (a ?ai= link, or remembered) is connected without a
// click when the browser asks nothing for it (granted, or no such permission); 'prompt' only
// invites the click; 'denied' says so. Nothing happens once the user has acted (a click's connect
// or Disconnect while the permission was read). `fetchFn` is for tests.
export async function connectAtLoad(
  fetchFn: typeof fetch = (...args) => fetch(...args)
): Promise<void> {
  if (aiServerKind() !== 'bridge' || state !== 'not-connected') return;
  const mine = attempt;
  const permission = await loopbackPermissionState();
  if (mine !== attempt || state !== 'not-connected' || aiServerKind() !== 'bridge') return;
  if (permission === 'granted' || permission === 'unsupported') return connectBridge(fetchFn);
  if (permission === 'denied') return set('denied', null, '');
  invited = true;
  set('not-connected', null, '');
}

// Forgets the bridge: the page is back to this site's own endpoints, and an answer still on its
// way is dropped
export function disconnectBridge(): void {
  attempt++;
  invited = false;
  if (aiServerKind() === 'bridge') forgetAiServer();
  set('not-connected', null, '');
}

// The bridge's status (server/bridge.ts, BridgeStatus) checked field by field, or why it is not
// the bridge's
async function readStatus(res: Response, address: string): Promise<BridgeInfo | string> {
  const body = await statusBody(res, 'the AI bridge’s');
  if (typeof body === 'string') return body;
  const b = body as { bridge?: unknown; llm?: unknown };
  if (b.bridge !== true) return 'something else answers there';
  return { address, ...readRuns(b.llm) };
}

// A status answer's JSON, or why it is none: a redirect (never followed), an HTTP error, over
// 1 MB, not JSON. `whose` names what it should have been
export async function statusBody(res: Response, whose: string): Promise<object | string> {
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    res.body?.cancel().catch(() => undefined);
    return 'it answered with a redirect';
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    return `HTTP ${res.status}: something else answers there`;
  }
  try {
    const text = await res.text();
    if (text.length > MAX_STATUS_BYTES) return 'its answer is too large';
    const body: unknown = JSON.parse(text);
    return body && typeof body === 'object' ? body : `its answer is not ${whose}`;
  } catch {
    return `its answer is not ${whose}`;
  }
}

// The status's `llm` (server/bridge.ts, BridgeStatus['llm']; the dev server's too), each field
// checked: booleans only when true, the local server an http(s) origin, model names and command
// ids as Models.ts takes them, Codex's reason as cut text; what a bridge before 1.1.0 does not
// have (codex, gemini, custom) is null
export function readRuns(value: unknown): ServerRuns {
  const llm = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const local = (llm.local && typeof llm.local === 'object' ? llm.local : {}) as {
    url?: unknown;
    models?: unknown;
  };
  const { models, rejected } = modelList(local.models);
  const commands = commandList(llm.custom);
  const codex =
    llm.codex && typeof llm.codex === 'object' ? (llm.codex as Record<string, unknown>) : null;
  return {
    claude: llm.claude === true,
    codex: codex && {
      available: codex.available === true,
      reason: codex.available === true ? '' : reasonText(codex.reason),
    },
    gemini: typeof llm.gemini === 'boolean' ? llm.gemini : null,
    openrouter: llm.openrouter === true,
    localUrl: originOf(local.url),
    models,
    custom: commands.custom,
    rejected: [...rejected, ...commands.rejected],
  };
}

// A reason from the server, as text for the menu: control characters out, cut
function reasonText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON)}…` : text;
}

// The commands a status lists: ids "cli:<name>" (Models.cliToolOf), once each, at most
// MAX_COMMANDS, labelled by Models.modelLabel; anything else left out and kept, cut, for the menu
export function commandList(value: unknown): {
  custom: CustomCommand[] | null;
  rejected: string[];
} {
  if (!Array.isArray(value)) return { custom: null, rejected: [] };
  const custom: CustomCommand[] = [];
  const rejected: string[] = [];
  for (const entry of value as unknown[]) {
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && cliToolOf(id) !== null) {
      if (!custom.some((c) => c.id === id) && custom.length < MAX_COMMANDS)
        custom.push({
          id,
          label: modelLabel(id),
          available: (entry as { available?: unknown }).available === true,
        });
    } else rejected.push(cut(typeof id === 'string' ? id : entry));
  }
  return { custom, rejected };
}

// An entry that cannot be a name, as text for the menu (cut)
function cut(entry: unknown): string {
  const text = typeof entry === 'string' ? entry : (JSON.stringify(entry) ?? String(entry));
  return text.length > MAX_REJECTED_SHOWN ? `${text.slice(0, MAX_REJECTED_SHOWN)}…` : text;
}

// An http(s) origin as the bridge gives LOCAL_LLM_URL's, or null
function originOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
      ? value
      : null;
  } catch {
    return null;
  }
}

// The names a model may have (Models.isLocalModelName), once each, at most MAX_MODELS; anything
// else is left out and kept, cut, for the menu to say so
export function modelList(value: unknown): { models: string[] | null; rejected: string[] } {
  if (!Array.isArray(value)) return { models: null, rejected: [] };
  const models: string[] = [];
  const rejected: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry === 'string' && isLocalModelName(entry)) {
      if (!models.includes(entry) && models.length < MAX_MODELS) models.push(entry);
    } else rejected.push(cut(entry));
  }
  return { models, rejected };
}
