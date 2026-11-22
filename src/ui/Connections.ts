import { aiServerBase, aiServerKind } from '../ai/AiServer';
import {
  bridgeConnected,
  bridgeConnection,
  connectAtLoad,
  connectBridge,
  disconnectBridge,
  onBridgeChange,
  type ServerRuns,
} from '../ai/BridgeConnect';
import { onServerStatusChange, serverRuns, serverStatus } from '../ai/ServerStatus';
import {
  completeConnect,
  connection,
  disconnectOpenRouter,
  onConnectionChange,
  startConnect,
} from '../ai/OpenRouterConnect';
import { closeDialog, openDialog, wireDialog } from './Dialog';

// The ways an LLM side can run on this page, and the title screen's AI connections, a card each:
// OpenRouter (the visitor's own account, from the browser; OpenRouterConnect.ts) and This computer
// (the AI bridge, BridgeConnect.ts), or, on a page with an AI server of its own, an AI server card
// in place of This computer, saying what it runs once Match setup has asked it (ServerStatus.ts).
// Match setup's in-place "Connect…" actions run the same flows (connectRouter, connectBridgeNow).
// The bridge's instructions (how to start it, or how to allow it again when the browser blocks
// it) open in a dialog: from its card's button, or when a connect the user started fails. A page
// opened with a bridge's address (the link the bridge opens when it starts, or one remembered)
// connects it at load when the browser asks nothing for that (BridgeConnect.connectAtLoad), and
// otherwise invites the one click that does: the card stands out, its Connect has the focus.

// The one rule for "this page has an AI server of its own": the dev server's endpoints on this
// site (npm run dev), or an AI server elsewhere given in the demo link (?ai=, a tunnel to the
// author's dev server, D37). The static site has none, and the AI bridge on this computer is not
// the page's own either: it is connected here, and what it can run is in its status.
export function ownAiServer(): boolean {
  const kind = aiServerKind();
  return kind === 'remote' || (kind === 'site' && import.meta.env.DEV);
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class Connections {
  // A connect the user started failed: its instructions open (once per click)
  private bridgeHelpOnFail = false;
  // A bridge is in play on this page (its address came with the page or is remembered, or a
  // connect was tried): its full card, for the rest of the page load; before that one quiet line
  private bridgeInPlay = false;
  // The button that started it, where the focus goes back after the instructions
  private connectFrom: HTMLElement | null = null;
  private bridgeDialog = $('bridge-dialog');

  // `choices`: Match setup's choices and the screen, kept for the trip to openrouter.ai
  constructor(private choices: () => unknown) {
    wireDialog(this.bridgeDialog);
    $('openrouter-connect').addEventListener('click', () => this.connectRouter());
    $('openrouter-disconnect').addEventListener('click', () => disconnectOpenRouter());
    // The request is made in the click itself, so the browser's question about reaching this
    // computer belongs to it; nothing calls the bridge when the page loads
    $('bridge-connect').addEventListener('click', () => this.connectBridgeNow());
    $('bridge-retry').addEventListener('click', () => this.connectBridgeNow());
    $('bridge-disconnect').addEventListener('click', () => disconnectBridge());
    $('bridge-help-open').addEventListener('click', () => this.openBridgeHelp());
    $('bridge-own').addEventListener('click', () => this.openBridgeHelp());
    $('bridge-copy').addEventListener('click', () => void this.copyCommand());
    onConnectionChange(() => this.show());
    onBridgeChange(() => this.bridgeChanged());
    onServerStatusChange(() => this.show());
    this.show();
    void connectAtLoad();
  }

  // The dialog's command, to the clipboard: only on the click, with "Copied" shown (or how to copy
  // it by hand when the browser refuses)
  private async copyCommand(): Promise<void> {
    const button = $('bridge-copy');
    const command = (
      document.querySelector('#bridge-help-start .bridge-commands')?.textContent ?? ''
    ).trim();
    let copied = false;
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch {
      // no clipboard here (an older browser, or it refused)
    }
    button.textContent = copied ? 'Copied' : 'Select it to copy';
    clearTimeout(this.copiedTimer);
    this.copiedTimer = window.setTimeout(() => (button.textContent = 'Copy'), 2500);
  }
  private copiedTimer = 0;

  // Called once at page load: back from openrouter.ai, the choices kept for the trip (or null when
  // this load has nothing to do with connecting)
  completeAtLoad(): { menu: unknown } | null {
    return completeConnect();
  }

  // "Connect with OpenRouter": the page goes to openrouter.ai and back, so a run (or replay) behind
  // the menu ends; asked first
  connectRouter(): void {
    const run = !$('menu-continue').hidden;
    if (
      run &&
      !window.confirm(
        'Connecting goes to openrouter.ai and back, which reloads this page: the current run ends. Go on?'
      )
    )
      return;
    void startConnect(this.choices());
  }

  // "Connect to the AI bridge", from a click: the status request is made before anything else
  connectBridgeNow(): void {
    this.bridgeHelpOnFail = true;
    this.bridgeInPlay = true;
    const from = document.activeElement as HTMLElement | null;
    if (from && !this.bridgeDialog.contains(from)) this.connectFrom = from;
    void connectBridge();
  }

  openBridgeHelp(): void {
    this.showBridgeHelp();
    openDialog(this.bridgeDialog, $('bridge-retry'), this.connectFrom);
  }

  // --- The cards ---

  private bridgeChanged(): void {
    const { state, invited } = bridgeConnection();
    const failed = state === 'unreachable' || state === 'denied';
    if (failed && this.bridgeHelpOnFail) {
      this.bridgeHelpOnFail = false;
      this.openBridgeHelp();
    } else if (state === 'connected') {
      this.bridgeHelpOnFail = false;
      closeDialog(this.bridgeDialog);
    }
    this.show();
    // The one click the browser's question needs: Connect gets the focus on the title screen,
    // unless the user is on something else there
    const active = document.activeElement;
    const idle = !active || active === document.body || active.id === 'title-play';
    if (invited && document.body.dataset.screen === 'title' && idle && !this.dialogShown())
      $('bridge-connect').focus();
  }

  private dialogShown(): boolean {
    return (this.bridgeDialog as HTMLDialogElement).open === true;
  }

  private show(): void {
    const own = ownAiServer();
    // The state hooks for the styles and the lamps (menu.css, menu-fx.css)
    const cards = $('connections');
    cards.dataset.server = own ? 'own' : 'none';
    cards.dataset.openrouter = connection().status;
    const bridge = bridgeConnection();
    cards.dataset.bridge = bridge.invited ? 'invite' : bridge.state;
    // OpenRouter is the main way; the bridge is a card once it is in play, one line before
    if (aiServerKind() === 'bridge' || bridge.state !== 'not-connected') this.bridgeInPlay = true;
    cards.dataset.own = own ? 'none' : this.bridgeInPlay ? 'card' : 'line';
    $('conn-server').hidden = !own;
    $('conn-bridge').hidden = own || !this.bridgeInPlay;
    $('conn-own').hidden = own || this.bridgeInPlay;
    if (own) this.showServer();
    this.showRouter(own);
    this.showBridge();
  }

  // The page's own AI server: where it is, and what it runs once Match setup has asked it
  private showServer(): void {
    $('server-status').textContent = aiServerKind() === 'remote' ? aiServerBase() : 'this site';
    const { state, runs, detail } = serverStatus();
    $('server-details').textContent =
      state === 'known' && runs
        ? runsLine(runs, 'server')
        : state === 'failed'
          ? `It did not say what it runs (${detail}): Match setup offers Claude, OpenRouter's models and local models by name.`
          : 'Match setup lists the models it runs.';
  }

  private showRouter(own: boolean): void {
    const { status, message } = connection();
    const connect = $('openrouter-connect') as HTMLButtonElement;
    connect.hidden = status === 'connected';
    connect.disabled = status === 'connecting';
    $('openrouter-disconnect').hidden = status !== 'connected';
    $('openrouter-status').textContent = routerStatus(own);
    const text = $('openrouter-message');
    text.textContent = message;
    text.hidden = message === '';
  }

  private showBridge(): void {
    const { state, info, invited } = bridgeConnection();
    const connect = $('bridge-connect') as HTMLButtonElement;
    const failed = state === 'unreachable' || state === 'denied';
    connect.hidden = state === 'connected';
    connect.disabled = state === 'connecting';
    connect.textContent = failed ? 'Try again' : 'Connect';
    // A bridge the page remembers can be forgotten without being reached first
    $('bridge-disconnect').hidden = state !== 'connected' && aiServerKind() !== 'bridge';
    // Its instructions until it is connected (blocked by the browser: how to allow it again)
    const help = $('bridge-help-open');
    help.hidden = state === 'connected';
    help.textContent = state === 'denied' ? 'How to allow it' : 'How to start it';
    $('bridge-status').textContent = bridgeStatus();
    const details = $('bridge-details');
    details.textContent = info
      ? runsLine(info, 'bridge')
      : invited
        ? 'One click: the browser then asks whether this site may reach your computer. Allow it.'
        : '';
    details.hidden = !info && !invited;
    this.showBridgeHelp();
  }

  // The dialog: how to start the bridge, or (blocked by the browser) only how to allow it again;
  // its status line only once a connect was tried (opened from How to start it before: none)
  private showBridgeHelp(): void {
    const { state } = bridgeConnection();
    $('bridge-dialog-status').textContent =
      state === 'unreachable' || state === 'denied' || state === 'connecting' ? bridgeStatus() : '';
    $('bridge-help-start').hidden = state === 'denied';
    $('bridge-help-denied').hidden = state !== 'denied';
    const retry = $('bridge-retry') as HTMLButtonElement;
    retry.disabled = state === 'connecting';
    retry.textContent = state === 'not-connected' ? 'Connect' : 'Try again';
  }
}

// The OpenRouter line's status
export function routerStatus(own = ownAiServer()): string {
  const { status } = connection();
  if (status === 'connected') return 'Connected: your own account, from this browser';
  if (status === 'connecting') return 'Connecting…';
  // The AI server's key, unless the AI server said it has none
  if (own)
    return serverRuns()?.openrouter === false
      ? 'Not connected'
      : "Not connected (the AI server's key is used)";
  if (bridgeConnected()?.openrouter) return "Not connected (the AI bridge's key is used)";
  return 'Not connected';
}

// The bridge line's status
export function bridgeStatus(): string {
  const { state, detail, address, invited } = bridgeConnection();
  if (invited) return `Your computer's bridge is waiting: press Connect (${address})`;
  switch (state) {
    case 'connected':
      return `Bridge connected: ${address}`;
    case 'connecting':
      return `Checking ${address}… If the browser asks whether this site may access apps on this device, allow it.`;
    case 'denied':
      return 'Blocked by the browser';
    case 'unreachable':
      return `Not reached at ${address}${detail ? ` (${detail})` : ''}`;
    default:
      return aiServerKind() === 'bridge'
        ? `Not checked yet: the bridge at ${address}`
        : 'Bridge not connected';
  }
}

// What a server runs (the AI bridge, or the page's own AI server), in one line of text (shown as
// text): its local models, Claude, Codex, Gemini, OpenRouter on its key, its commands; what it
// cannot run by name (Match setup's list says why); entries of its lists that cannot be a name
export function runsLine(runs: ServerRuns, where: 'bridge' | 'server'): string {
  const shown = 3;
  const models = runs.models;
  const runsNow: string[] = [];
  const off: string[] = [];
  if (runs.localUrl === null) off.push('local models (LOCAL_LLM_URL cannot work)');
  else if (models === null)
    runsNow.push(`local models by name (${runs.localUrl} lists none: is it running?)`);
  else if (models.length === 0) runsNow.push(`local models by name (none at ${runs.localUrl} yet)`);
  else
    runsNow.push(
      `${models.slice(0, shown).join(', ')}${models.length > shown ? ` and ${models.length - shown} more` : ''} (local)`
    );
  (runs.claude ? runsNow : off).push('Claude');
  (runs.codex?.available ? runsNow : off).push('Codex');
  (runs.gemini ? runsNow : off).push('Gemini');
  (runs.openrouter ? runsNow : off).push(
    runs.openrouter
      ? `OpenRouter (${where === 'bridge' ? "the bridge's" : 'its'} key)`
      : 'OpenRouter'
  );
  // A command by its name (the card is the computer's or the server's own)
  for (const c of runs.custom ?? [])
    (c.available ? runsNow : off).push(`${c.id.slice('cli:'.length)} (command)`);
  const parts = [
    runsNow.length ? `Runs ${runsNow.join('; ')}.` : 'Runs nothing this page can use.',
  ];
  if (off.length) parts.push(`Off: ${off.join(', ')}; see Match setup.`);
  if (runs.rejected.length)
    parts.push(
      `Left out ${runs.rejected.length === 1 ? 'a name' : `${runs.rejected.length} names`} that cannot be a model's: "${runs.rejected[0]}".`
    );
  return parts.join(' ');
}
