import {
  SimConfig,
  BATTLE_CONFIG,
  TerrainDensity,
  SideAI,
  LlmModel,
  TacticalModel,
  Objective,
} from '../types/types';
import {
  CLAUDE_MODELS,
  cliToolOf,
  codexModel,
  GEMINI_MODELS,
  geminiModelId,
  isLlmModel,
  isLocalModelName,
  isOpenRouterId,
  modelLabel,
  OPENROUTER_MODELS,
} from '../ai/Models';
import { aiServerKind } from '../ai/AiServer';
import {
  bridgeConnected,
  bridgeConnection,
  onBridgeChange,
  type ServerRuns,
} from '../ai/BridgeConnect';
import { askServerStatus, onServerStatusChange, serverRuns } from '../ai/ServerStatus';
import { connection, onConnectionChange } from '../ai/OpenRouterConnect';
import type { Side } from '../engine/Sides';
import { Dropdown, DropdownItem } from './Dropdown';
import { MapChoice } from './MapChoice';
import { bridgeStatus, ownAiServer, type Connections } from './Connections';
import { segOffers, segValue, setSeg, wireSeg } from './seg';
import { SIDE_NAME } from './format';

// Match setup (battle mode): the two sides face each other, the battle's options between them.
// A side card: who commands it (You or Rules, the LLM, the LLM with Jev or SubQ Snap: D38, D51),
// and for an LLM where it runs and its model, as one control: the ways that can work on this page
// (WAYS), each with the models it can run (D29, D52, local models, Codex, Gemini, commands of the
// server's own), or, for a way that is not connected, its "Connect…" in place of the model list.
// What the AI bridge or the page's own AI server says it cannot run is listed too, disabled, with
// why (its status: BridgeConnect.ts, ServerStatus.ts). A way that cannot run is never preselected:
// a side starts on the first way that is ready, or on none; nor is a model that cannot. The battle
// card: objective, map, soldiers, terrain, AI timing (D4), replay. Start's checks say what is wrong
// next to the control they concern.

// Where a side's LLM runs: the page's own AI server (npm run dev, a tunnel), the visitor's
// OpenRouter account from the browser, or the AI bridge on this computer
export type Way = 'server' | 'openrouter' | 'bridge';
export const WAYS: Way[] = ['server', 'openrouter', 'bridge'];

// Each side's "who commands it" button group
export const SIDE_GROUP: Record<Side, string> = { west: 'cfg-west', east: 'cfg-opponent' };
const SIDES: Side[] = ['west', 'east'];

const DEFAULT_PICK: Record<Way, string> = {
  server: 'sonnet',
  openrouter: 'openrouter:anthropic/claude-sonnet-5.5',
  bridge: '',
};
// A model typed by name: "Other model id…" (OpenRouter), "Other name…" (a local model), "A Codex
// model by name…", "Other Gemini model…"; each has its own field
const OTHER_ROUTER = 'openrouter:';
const OTHER_LOCAL = 'local:';
const OTHER_CODEX = 'codex:';
const OTHER_GEMINI = 'gemini:';
const FIELD: Record<string, string> = {
  [OTHER_ROUTER]: 'router-id',
  [OTHER_LOCAL]: 'local-id',
  [OTHER_CODEX]: 'codex-id',
  [OTHER_GEMINI]: 'gemini-id',
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;

interface SideState {
  wayChosen: boolean; // the way is the user's (or put back), not preselected
  picks: Record<Way, string>; // the model picked on each way
  list: Dropdown;
}

export class MatchSetup {
  readonly map = new MapChoice('cfg-map', 'cfg-map-saved');
  private warriors = $('cfg-warriors') as HTMLInputElement;
  private warriorsNum = $('cfg-warriors-num') as HTMLInputElement;
  private sides = {} as Record<Side, SideState>;
  // Called after any change of the controls (the plain-language lines follow them)
  onChange: () => void = () => {};

  constructor(private connections: Connections) {
    const { warriors, warriorsNum } = this;
    // The soldiers slider and its number, kept in sync; the number shows the clamped value once
    // editing is done (clamping while typing would fight the user)
    warriors.addEventListener('input', () => (warriorsNum.value = warriors.value));
    warriorsNum.addEventListener('input', () => {
      const v = Math.min(2000, Math.max(0, parseInt(warriorsNum.value) || 0));
      warriors.value = v.toString();
    });
    warriorsNum.addEventListener('change', () => (warriorsNum.value = warriors.value));
    for (const id of ['cfg-objective', 'cfg-terrain', 'cfg-timing', 'cfg-replay'])
      wireSeg(id, () => this.changed());

    for (const side of SIDES) {
      const list = new Dropdown($(`cfg-${side}-model`), [], '');
      this.sides[side] = { wayChosen: false, picks: { ...DEFAULT_PICK }, list };
      list.onChoose((value) => {
        const way = this.way(side);
        if (way) this.sides[side].picks[way] = value;
        this.refresh();
        // A model typed by name: its field gets the focus
        if (FIELD[value]) this.field(side, value).focus();
      });
      wireSeg(SIDE_GROUP[side], () => this.changed());
      wireSeg(`cfg-${side}-way`, () => {
        this.sides[side].wayChosen = true;
        this.changed();
      });
      $(`connect-${side}-btn`).addEventListener('click', () => {
        if (this.way(side) === 'openrouter') this.connections.connectRouter();
        else this.connections.connectBridgeNow();
      });
    }
    onConnectionChange(() => this.refresh());
    onBridgeChange(() => this.refresh());
    onServerStatusChange(() => this.refresh());
    this.refresh();
  }

  // Match setup is shown (FrontEnd): the page's own AI server is asked once what it runs
  opened(): void {
    if (ownAiServer()) void askServerStatus();
    this.refresh();
  }

  // --- Presets (the title screen's choices) ---

  // Quick battle: the user commands West against the rules, elimination on a random map with
  // the default army
  presetPlay(): void {
    setSeg('cfg-objective', 'elimination');
    setSeg(SIDE_GROUP.west, 'none');
    setSeg(SIDE_GROUP.east, 'none');
    setSeg('cfg-terrain', 'normal');
    this.map.choice = 'random';
    this.warriors.value = this.warriorsNum.value = String(BATTLE_CONFIG.warriorCount);
    this.changed();
  }

  // AI vs AI: an LLM on both sides (a side that already has one keeps it)
  presetAiVsAi(): void {
    for (const side of SIDES)
      if (!segValue(SIDE_GROUP[side]).includes('llm')) setSeg(SIDE_GROUP[side], 'llm');
    this.changed();
  }

  // The first thing to choose: West's way (the one shown active, or the first offered)
  focusFirst(): void {
    const group = $('cfg-west-way');
    const target =
      group.querySelector<HTMLElement>('button.active') ??
      Array.from(group.querySelectorAll<HTMLElement>('button')).find((b) => !b.hidden);
    target?.focus();
  }

  // --- Showing ---

  private changed(): void {
    this.clearMessages();
    this.refresh();
  }

  // Every control follows the choices and the connections
  refresh(): void {
    for (const side of SIDES) this.showSide(side);
    const ai = SIDES.some((side) => segValue(SIDE_GROUP[side]) !== 'none');
    $('row-timing').hidden = !ai;
    this.onChange();
  }

  private showSide(side: Side): void {
    const commander = segValue(SIDE_GROUP[side]);
    const llm = commander.includes('llm');
    $(`llm-${side}`).hidden = !llm;
    const card = $(`setup-${side}`);
    card.dataset.commander = commander;
    const state = this.sides[side];
    // Ways this page offers: the AI server only when it has one; the bridge only when it does not
    const own = ownAiServer();
    const group = `cfg-${side}-way`;
    for (const btn of Array.from($(group).querySelectorAll('button'))) {
      const way = (btn as HTMLButtonElement).dataset.val as Way;
      btn.hidden = way === 'server' ? !own : way === 'bridge' ? own : false;
    }
    let way = this.way(side);
    if (way && !segOffers(group, way)) way = '';
    // Not the user's: the first way that is ready now, or none
    if (!state.wayChosen || !way) {
      way = WAYS.find((w) => segOffers(group, w) && ready(w)) ?? '';
      if (!state.wayChosen) setSeg(group, way);
      else if (way) setSeg(group, way);
    }
    card.dataset.way = way;
    card.dataset.ready = String(!!way && ready(way));
    if (!way) {
      setSeg(group, '');
      this.showConnect(side, null);
      return;
    }
    if (!ready(way)) {
      this.showConnect(side, way);
      return;
    }
    $(`connect-${side}`).hidden = true;
    $(`pick-${side}`).hidden = false;
    const pick = state.picks[way] || DEFAULT_PICK[way];
    state.list.setItems(modelItems(way), pick);
    state.picks[way] = state.list.value;
    this.showFields(side, way, state.list.value);
  }

  // The model typed by name: its field; and a line on what the chosen model runs on
  private showFields(side: Side, way: Way, value: string): void {
    for (const [other, id] of Object.entries(FIELD))
      $(`cfg-${side}-${id}`).hidden = value !== other;
    const hint = $(`cfg-${side}-hint`);
    const text = modelHint(way, value);
    hint.textContent = text;
    hint.hidden = text === '';
  }

  // A way that is not connected: what it needs, with its Connect… in place of the model list
  private showConnect(side: Side, way: Way | null): void {
    $(`pick-${side}`).hidden = true;
    const box = $(`connect-${side}`);
    const btn = $(`connect-${side}-btn`) as HTMLButtonElement;
    const text = $(`connect-${side}-text`);
    box.hidden = false;
    btn.hidden = way === null || way === 'server';
    btn.disabled = false;
    if (way === null) {
      text.textContent =
        'Choose where the LLM runs: your OpenRouter account, or the AI bridge on this computer.';
    } else if (way === 'openrouter') {
      const { status, message } = connection();
      btn.disabled = status === 'connecting';
      btn.textContent = 'Connect…';
      text.textContent =
        status === 'connecting'
          ? 'Connecting with OpenRouter…'
          : message || 'Your OpenRouter account is not connected.';
    } else if (way === 'bridge') {
      const { state } = bridgeConnection();
      const failed = state === 'unreachable' || state === 'denied';
      btn.disabled = state === 'connecting';
      btn.textContent = failed ? 'Try again' : 'Connect…';
      const info = bridgeConnected();
      text.textContent = info
        ? `The AI bridge runs no model this page can use. ${whyNothing(info, 'bridge')}`
        : `${bridgeStatus()}.`;
      btn.hidden = !!info;
    } else {
      const runs = serverRuns();
      text.textContent = runs
        ? `The AI server runs no model this page can use. ${whyNothing(runs, 'server')}`
        : 'The AI server cannot be reached.';
    }
  }

  // --- Start ---

  // The run Start sets up from these controls, or null with a message next to the control that
  // cannot run as chosen
  read(): { cfg: SimConfig; mapChoice: string } | null {
    this.clearMessages();
    const mapProblem = this.map.problem();
    if (mapProblem) {
      this.say('msg-battle', mapProblem, () => this.map.focus());
      return null;
    }
    for (const side of SIDES) {
      const problem = this.problem(side);
      if (problem) {
        this.say(`msg-${side}`, problem.text, problem.focus);
        return null;
      }
    }
    const cfg: SimConfig = {
      ...BATTLE_CONFIG,
      warriorCount: parseInt(this.warriors.value),
      terrainDensity: segValue('cfg-terrain') as TerrainDensity,
      objective: segValue('cfg-objective') as Objective,
      presetGrid: this.map.grid(),
      friendlyAI: this.sideAi('west'),
      enemyAI: this.sideAi('east'),
      aiTiming: segValue('cfg-timing') === 'paused' ? 'paused' : 'realtime',
      recordReplay: segValue('cfg-replay') !== 'off',
      friendlyModel: this.model('west') ?? 'sonnet',
      enemyModel: this.model('east') ?? 'sonnet',
      friendlyTactical: this.tactical('west'),
      enemyTactical: this.tactical('east'),
    };
    return { cfg, mapChoice: this.map.label() };
  }

  // Why a side cannot run as chosen on this page (and what to focus), or null when it can: where
  // its requests go and whether that can run them. A match that would only fail is not started.
  private problem(side: Side): { text: string; focus: () => void } | null {
    const ai = segValue(SIDE_GROUP[side]);
    if (!ai.includes('llm')) return null;
    const name = SIDE_NAME[side];
    const way = this.way(side);
    const atWay = () => this.focusWay(side);
    const atConnect = () => $(`connect-${side}-btn`).focus();
    const atList = () => $(`cfg-${side}-model`).querySelector<HTMLElement>('.dd-button')?.focus();
    // The tactical layer always asks the page's AI server, and the bridge has no Jev or Snap
    // (their keys are the author's, D7): it would stop at its first request
    if (ai !== 'llm' && aiServerKind() === 'bridge')
      return {
        text: `The ${name} side is set to "${ai === 'snap+llm' ? 'LLM + Snap' : 'LLM + Jev'}", but the AI bridge serves the LLM only: Jev and SubQ Snap are not available through it. Choose "LLM" for the ${name} side.`,
        focus: () => $(SIDE_GROUP[side]).querySelector<HTMLElement>('button.active')?.focus(),
      };
    if (!way)
      return {
        text: `The ${name} LLM has nowhere to run yet: choose OpenRouter or This computer, then connect it.`,
        focus: atWay,
      };
    if (way === 'openrouter' && connection().status === 'connecting')
      return {
        text: 'Still connecting with OpenRouter: wait a moment, then press Start again.',
        focus: atWay,
      };
    if (way === 'openrouter' && connection().status !== 'connected')
      return {
        text: `The ${name} LLM runs on your OpenRouter account, which is not connected: press "Connect…" first, or choose another way.`,
        focus: atConnect,
      };
    const bridge = bridgeConnected();
    if (way === 'bridge' && !bridge) {
      const { state, address } = bridgeConnection();
      if (state === 'connecting')
        return {
          text: 'Still checking the AI bridge: wait a moment, then press Start again.',
          focus: atWay,
        };
      return {
        text:
          aiServerKind() === 'bridge'
            ? `The ${name} LLM runs on the AI bridge at ${address}, which this page has not reached yet: press "Connect…" first. The browser may ask whether this site may access apps on this device.`
            : `The ${name} LLM runs on this computer, and the AI bridge is not connected: start it (npm run bridge), then press "Connect…".`,
        focus: atConnect,
      };
    }
    if (way === 'bridge' && bridge && !ready('bridge'))
      return {
        text: `The AI bridge on this computer runs no model this page can use (${whyNothing(bridge, 'bridge')}): fix it where you start the bridge and start it again, or choose another way.`,
        focus: atWay,
      };
    const runs = serverRuns();
    if (way === 'server' && runs && !ready('server'))
      return {
        text: `The AI server runs no model this page can use (${whyNothing(runs, 'server')}): choose another way.`,
        focus: atWay,
      };
    const value = this.sides[side].list.value;
    // A mistyped OpenRouter id or local model name must not silently run another model: model
    // comparisons rely on it
    if (value === OTHER_ROUTER && !this.model(side))
      return {
        text: `Type the ${name} model's OpenRouter id, e.g. "google/gemini-3.8-flash".`,
        focus: () => this.routerField(side).focus(),
      };
    if (value === OTHER_LOCAL && !this.model(side))
      return {
        text: `Type the ${name} model's name as your local server knows it, e.g. "qwen3:14b" (Ollama: ollama list). Letters, digits and . _ : / - only.`,
        focus: () => this.localField(side).focus(),
      };
    if (value === OTHER_CODEX && !this.model(side))
      return {
        text: `Type the ${name} Codex model's name, e.g. "gpt-6.1-sol", or choose "Codex" for its default model. Letters, digits and . _ : / - only.`,
        focus: () => this.field(side, OTHER_CODEX).focus(),
      };
    if (value === OTHER_GEMINI && !this.model(side))
      return {
        text: `Type the ${name} Gemini model's name as the Gemini API knows it, e.g. "${GEMINI_MODELS[0]}". Letters, digits and . _ : / - only.`,
        focus: () => this.field(side, OTHER_GEMINI).focus(),
      };
    if (!this.model(side)) return { text: `Choose the ${name} LLM's model.`, focus: atList };
    return null;
  }

  // Shows a Start message next to its control (an alert when that is not on screen) and focuses
  // the control
  private say(id: string, text: string, focus: () => void): void {
    const el = $(id);
    el.textContent = text;
    el.hidden = false;
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0)
      window.alert(text);
    el.scrollIntoView?.({ block: 'nearest' });
    focus();
  }

  clearMessages(): void {
    for (const id of ['msg-west', 'msg-east', 'msg-battle']) {
      const el = $(id);
      el.hidden = true;
      el.textContent = '';
    }
  }

  // --- Reading the controls ---

  way(side: Side): Way | '' {
    return segValue(`cfg-${side}-way`) as Way | '';
  }

  // The LLM chosen for a side: a Claude alias, "openrouter:<id>" (D52), "local:<name>",
  // "codex[:<model>]", "gemini:<model>" or "cli:<name>"; null when a typed id or name cannot be one
  // or the way offers no model
  model(side: Side): LlmModel | null {
    const way = this.way(side);
    if (!way || !ready(way)) return null;
    const value = this.sides[side].list.value;
    if (value === OTHER_ROUTER) {
      const id = this.routerField(side).value.trim();
      return isOpenRouterId(id) ? `openrouter:${id}` : null;
    }
    if (FIELD[value]) {
      // "local:", "codex:", "gemini:" and a name with a local model's characters
      const name = this.field(side, value).value.trim();
      return isLocalModelName(name) ? (`${value}${name}` as LlmModel) : null;
    }
    return isLlmModel(value) ? value : null;
  }

  // The model picked on each way (kept for the trip to openrouter.ai)
  picks(side: Side): Record<Way, string> {
    return { ...this.sides[side].picks };
  }

  // Puts back a side's picks and whether its way was chosen (the trip to openrouter.ai)
  restorePicks(side: Side, picks: Record<string, unknown>, wayChosen: boolean): void {
    for (const way of WAYS) {
      const v = picks[way];
      if (typeof v === 'string' && v.length <= 200) this.sides[side].picks[way] = v;
    }
    this.sides[side].wayChosen = wayChosen;
  }

  wayChosen(side: Side): boolean {
    return this.sides[side].wayChosen;
  }

  private focusWay(side: Side): void {
    const group = $(`cfg-${side}-way`);
    (
      group.querySelector<HTMLElement>('button.active') ??
      Array.from(group.querySelectorAll<HTMLElement>('button')).find((b) => !b.hidden)
    )?.focus();
  }

  // "LLM + Snap" is the LLM with Snap as its tactical layer (D51)
  private sideAi(side: Side): SideAI {
    const v = segValue(SIDE_GROUP[side]);
    return v === 'snap+llm' ? 'jev+llm' : (v as SideAI);
  }

  private tactical(side: Side): TacticalModel {
    return segValue(SIDE_GROUP[side]) === 'snap+llm' ? 'snap' : 'jev';
  }

  // The text field of a model typed by name ("openrouter:", "local:", "codex:", "gemini:")
  private field(side: Side, other: string): HTMLInputElement {
    return $(`cfg-${side}-${FIELD[other]}`) as HTMLInputElement;
  }

  private routerField(side: Side): HTMLInputElement {
    return this.field(side, OTHER_ROUTER);
  }

  private localField(side: Side): HTMLInputElement {
    return this.field(side, OTHER_LOCAL);
  }
}

// Whether a way can run an LLM now: the page's AI server (with a model it runs, once it said
// what it runs), the browser's OpenRouter connection, a connected AI bridge that offers a model
// this page can use
export function ready(way: Way): boolean {
  if (way === 'server') return ownAiServer() && modelItems('server').some((i) => !i.disabled);
  if (way === 'openrouter') return connection().status === 'connected';
  return modelItems('bridge').some((i) => !i.disabled);
}

// The models a way can run, and (disabled, with why) what its server says it cannot. OpenRouter
// models go straight from the browser whenever it is connected (LlmController), so they are listed
// under OpenRouter then, and not under the AI server or the bridge. The AI server lists, until it
// has said what it runs (or when it cannot say), what it always could: Claude, OpenRouter's list,
// a local model by name.
export function modelItems(way: Way): DropdownItem[] {
  const routerOn = connection().status === 'connected';
  if (way === 'openrouter') return routerItems('');
  if (way === 'server') {
    const runs = serverRuns();
    if (runs) return runsItems(runs, 'server', routerOn);
    return [
      ...claudeItems(),
      ...(routerOn ? [] : routerItems('OpenRouter: ')),
      { value: OTHER_LOCAL, label: 'A model by name…', group: 'Local' },
    ];
  }
  const bridge = bridgeConnected();
  return bridge ? runsItems(bridge, 'bridge', routerOn) : [];
}

const claudeItems = (): DropdownItem[] =>
  CLAUDE_MODELS.map((m) => ({ value: m, label: modelLabel(m), group: 'Claude' }));

const routerItems = (prefix: string): DropdownItem[] => [
  ...OPENROUTER_MODELS.map((m) => ({
    value: `openrouter:${m.id}`,
    label: m.label,
    group: `${prefix}${m.company}`,
  })),
  { value: OTHER_ROUTER, label: 'Other model id…', group: `${prefix}Other` },
];

type Where = 'bridge' | 'server';

// What a server cannot run, each with why (the disabled rows of its list, and Start's message
// when it runs nothing): `key` names the row
function offWays(
  runs: ServerRuns,
  where: Where,
  routerOn: boolean
): { key: string; label: string; note: string }[] {
  const bridge = where === 'bridge';
  const older = bridge
    ? 'This bridge does not say (an older version): start it again with the current command.'
    : 'The AI server does not say (an older version).';
  const off: { key: string; label: string; note: string }[] = [];
  if (runs.localUrl === null)
    off.push({
      key: 'local',
      label: 'Local models',
      note: bridge
        ? 'LOCAL_LLM_URL cannot work: fix it where you start the bridge.'
        : 'LOCAL_LLM_URL cannot work on the AI server.',
    });
  if (!runs.claude)
    off.push({
      key: 'claude',
      label: 'Claude',
      note: bridge
        ? "The bridge could not load Anthropic's Agent SDK (start it with the npx command), or its ANTHROPIC_API_KEY cannot be sent."
        : 'The AI server cannot run Claude.',
    });
  if (!runs.codex?.available)
    off.push({
      key: 'codex',
      label: 'Codex',
      note:
        runs.codex === null
          ? older
          : runs.codex.reason || `${bridge ? 'The bridge' : 'The AI server'} cannot run Codex.`,
    });
  if (!runs.gemini)
    off.push({
      key: 'gemini',
      label: 'Gemini',
      note:
        runs.gemini === null
          ? older
          : bridge
            ? 'Set GEMINI_API_KEY where you start the bridge (.env.local or the environment), then start it again.'
            : "Set GEMINI_API_KEY in the AI server's .env.local, then restart it.",
    });
  if (!routerOn && !runs.openrouter)
    off.push({
      key: 'openrouter',
      label: 'OpenRouter',
      note: `No OPENROUTER_API_KEY on ${bridge ? 'the bridge' : 'the AI server'}; or connect OpenRouter as its own way.`,
    });
  for (const c of runs.custom ?? [])
    if (!c.available)
      off.push({
        key: c.id,
        label: c.label,
        note: `Its program was not found where ${bridge ? 'the bridge' : 'the AI server'} runs.`,
      });
  return off;
}

// Why a server runs nothing this page can use, in one line
function whyNothing(runs: ServerRuns, where: Where): string {
  const routerOn = connection().status === 'connected';
  return offWays(runs, where, routerOn)
    .map((o) => `${o.label}: ${o.note}`)
    .join(' ');
}

// A server's list from what it says it runs: the bridge's own models first (its local ones), the
// AI server's Claude first; then what it cannot run, disabled, with why
function runsItems(runs: ServerRuns, where: Where, routerOn: boolean): DropdownItem[] {
  const local: DropdownItem[] =
    runs.localUrl === null
      ? []
      : [
          ...(runs.models ?? []).map((m) => ({ value: `local:${m}`, label: m, group: 'Local' })),
          { value: OTHER_LOCAL, label: 'Other name…', group: 'Local' },
        ];
  const claude = runs.claude ? claudeItems() : [];
  const codex: DropdownItem[] = runs.codex?.available
    ? [
        { value: 'codex', label: 'Codex', group: 'Codex' },
        { value: OTHER_CODEX, label: 'A Codex model by name…', group: 'Codex' },
      ]
    : [];
  const gemini: DropdownItem[] = runs.gemini
    ? [
        ...GEMINI_MODELS.map((m) => ({ value: `gemini:${m}`, label: m, group: 'Gemini' })),
        { value: OTHER_GEMINI, label: 'Other Gemini model…', group: 'Gemini' },
      ]
    : [];
  const router = !routerOn && runs.openrouter ? routerItems('OpenRouter: ') : [];
  const commands = (runs.custom ?? [])
    .filter((c) => c.available)
    .map((c) => ({ value: c.id, label: c.label, group: 'Commands of its own' }));
  const order =
    where === 'bridge'
      ? [local, claude, codex, gemini, router, commands]
      : [claude, router, local, codex, gemini, commands];
  const group = where === 'bridge' ? 'Not on this bridge' : 'Not on the AI server';
  return [
    ...order.flat(),
    ...offWays(runs, where, routerOn).map((o) => ({
      value: `off:${o.key}`,
      label: o.label,
      note: o.note,
      group,
      disabled: true,
    })),
  ];
}

// The line under a side's model: what the chosen model runs on (a local name typed, Claude's,
// Codex's and Gemini's sign-in or key, a command of the server's), or nothing
function modelHint(way: Way, value: string): string {
  if (way === 'openrouter') return '';
  const bridge = way === 'bridge' ? bridgeConnected() : null;
  const there = way === 'bridge' ? 'where the bridge runs' : 'on the AI server';
  if (value === OTHER_LOCAL) {
    if (way === 'server')
      return "A model on the AI server's local model server (LOCAL_LLM_URL), by its name.";
    if (bridge?.models === null)
      return 'The bridge got no model list from the local server: type the name.';
    if (bridge?.models?.length === 0)
      return 'The local server has no models yet (ollama pull qwen3:14b): type the name.';
    return '';
  }
  if ((CLAUDE_MODELS as string[]).includes(value))
    return 'Uses the Claude Code sign-in on that computer (or ANTHROPIC_API_KEY, when it is set there).';
  if (value === OTHER_CODEX || codexModel(value))
    return 'Uses the Codex sign-in on that computer (codex login).';
  if (value === OTHER_GEMINI || geminiModelId(value))
    return `Runs on Google's Gemini API with the GEMINI_API_KEY set ${there}.`;
  const tool = cliToolOf(value);
  if (tool) return `Runs the command CLI_TOOL_${tool.toUpperCase()} of the settings ${there}.`;
  return '';
}
