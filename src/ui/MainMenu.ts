import { SimConfig, TerrainType } from '../types/types';
import { listSavedMaps, saveMap } from '../state/MapStore';
import type { Side } from '../engine/Sides';
import { Connections } from './Connections';
import { MatchSetup, WAYS, type Way } from './MatchSetup';
import { Sandbox, SANDBOX_TABS, SandboxTab } from './Sandbox';
import { MenuHelp } from './MenuHelp';
import { segOffers, segValue, setSeg } from './seg';

// The front end's settings: Match setup (battle mode, MatchSetup.ts), the Sandbox (classic,
// custom, stress test; Sandbox.ts) and the AI connections (Connections.ts). `readStart()` turns
// the controls of the screen in use into the run Start sets up. The choices go with the trip to
// openrouter.ai ("Connect with OpenRouter" reloads the page) and are put back when the page comes
// back (`choices`, `restore`), with the screen the user left.

// What Start runs: the stress test, or a run from these settings. `mapChoice` names the map for
// the match log: random, fixed or "saved: <name>".
export type StartChoice = { kind: 'stress' } | { kind: 'run'; cfg: SimConfig; mapChoice: string };

// The front end's screens (FrontEnd.ts)
export type MenuScreen = 'title' | 'setup' | 'sandbox';
const SCREENS: MenuScreen[] = ['title', 'setup', 'sandbox'];

// The controls kept over the trip to openrouter.ai: every button group and every slider, text
// field and saved-map list, the Sandbox tab and each side's model per way
const MENU_GROUPS = [
  'cfg-objective',
  'cfg-map',
  'cfg-terrain',
  'cfg-west',
  'cfg-opponent',
  'cfg-west-way',
  'cfg-east-way',
  'cfg-timing',
  'cfg-replay',
  'sb-map',
  'sb-terrain',
];
const MENU_FIELDS = [
  'cfg-warriors',
  'cfg-map-saved',
  'cfg-west-router-id',
  'cfg-east-router-id',
  'cfg-west-local-id',
  'cfg-east-local-id',
  'cfg-west-codex-id',
  'cfg-east-codex-id',
  'cfg-west-gemini-id',
  'cfg-east-gemini-id',
  'sb-warriors',
  'cfg-wave-slider',
  'sb-map-saved',
];
const MAX_FIELD = 200; // characters of a kept field that are put back

interface MenuChoices {
  screen: MenuScreen;
  tab: SandboxTab;
  groups: Record<string, string>;
  fields: Record<string, string>;
  ways: Record<Side, boolean>; // the way was the user's choice, not preselected
  picks: Record<Side, Record<string, string>>;
}

export class MainMenu {
  readonly connections: Connections;
  readonly setup: MatchSetup;
  readonly sandbox: Sandbox;
  // Which settings Start reads: Match setup or the Sandbox (the screen shown last of the two)
  mode: 'battle' | 'sandbox' = 'battle';
  // The front end's screen now, kept for the trip to openrouter.ai (FrontEnd sets it)
  screen: MenuScreen = 'title';
  // Back from openrouter.ai: the screen the user left (null: no trip, or nothing came back)
  readonly returnScreen: MenuScreen | null = null;

  constructor() {
    this.connections = new Connections(() => this.choices());
    this.setup = new MatchSetup(this.connections);
    this.sandbox = new Sandbox();
    const help = new MenuHelp();
    this.setup.onChange = () => help.refresh();
    this.sandbox.onChange = () => help.refresh();
    help.refresh();
    const back = this.connections.completeAtLoad();
    // Back from openrouter.ai: the screen and choices as they were (the title screen's
    // connections say how it went when nothing came back)
    if (back) {
      this.returnScreen = this.restore(back.menu) ?? 'title';
      this.screen = this.returnScreen;
      this.mode = this.returnScreen === 'sandbox' ? 'sandbox' : 'battle';
    }
  }

  // Reads the settings for Start. Settings that cannot run as chosen are explained next to their
  // control and give null: the screen stays.
  readStart(): StartChoice | null {
    if (this.mode === 'sandbox') return this.sandbox.read();
    const run = this.setup.read();
    return run ? { kind: 'run', ...run } : null;
  }

  // Saves the current terrain under a name so it can be chosen again in Match setup or the Sandbox
  saveCurrentMap(grid: TerrainType[][]): void {
    const defaultName = `map-${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const name = window.prompt('Save this map as:', defaultName)?.trim();
    if (!name) return;
    // Saving twice within a minute gives the same default name; never replace a map unasked
    if (
      listSavedMaps().includes(name) &&
      !window.confirm(`A map named "${name}" is already saved. Replace it?`)
    )
      return;
    if (!saveMap(name, grid)) {
      window.alert('Could not save the map (browser storage is unavailable).');
      return;
    }
    this.setup.map.refresh();
    this.sandbox.map.refresh();
  }

  // The choices, kept for the trip to openrouter.ai
  choices(): MenuChoices {
    const groups: Record<string, string> = {};
    for (const id of MENU_GROUPS) {
      const active = document.querySelector(`#${id} button.active`) as HTMLButtonElement | null;
      groups[id] = active?.dataset.val ?? '';
    }
    const fields: Record<string, string> = {};
    for (const id of MENU_FIELDS)
      fields[id] = (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;
    return {
      screen: this.screen,
      tab: this.sandbox.activeTab,
      groups,
      fields,
      ways: { west: this.setup.wayChosen('west'), east: this.setup.wayChosen('east') },
      picks: { west: this.setup.picks('west'), east: this.setup.picks('east') },
    };
  }

  // Puts back choices kept by choices(); only known controls, and only values they offer. Gives
  // the screen to show, or null when there is nothing to put back.
  private restore(kept: unknown): MenuScreen | null {
    const saved = (kept ?? {}) as Partial<Record<keyof MenuChoices, unknown>>;
    if (typeof saved.screen !== 'string' || !SCREENS.includes(saved.screen as MenuScreen))
      return null;
    const record = (v: unknown) =>
      v && typeof v === 'object' ? (v as Record<string, unknown>) : ({} as Record<string, unknown>);
    // The tab first: Classic sets the army of its own
    if (typeof saved.tab === 'string' && (SANDBOX_TABS as string[]).includes(saved.tab))
      this.sandbox.setTab(saved.tab as SandboxTab);
    const groups = record(saved.groups);
    for (const id of MENU_GROUPS) {
      const val = groups[id];
      if (typeof val === 'string' && segOffers(id, val)) setSeg(id, val);
    }
    const fields = record(saved.fields);
    for (const id of MENU_FIELDS) {
      const val = fields[id];
      if (typeof val !== 'string' || val.length > MAX_FIELD) continue;
      const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
      // A saved map that is no longer in the list is not chosen (its select would show nothing)
      const select = el.tagName.toLowerCase() === 'select';
      if (select && !Array.from((el as HTMLSelectElement).options).some((o) => o.value === val))
        continue;
      el.value = val;
    }
    const ways = record(saved.ways);
    const picks = record(saved.picks);
    // A way counts as the user's only when it was theirs and is offered here (it was put back)
    for (const side of ['west', 'east'] as const) {
      const chosen = ways[side] === true && WAYS.includes(segValue(`cfg-${side}-way`) as Way);
      this.setup.restorePicks(side, record(picks[side]), chosen);
    }
    // What is shown next to the controls follows them
    (document.getElementById('cfg-warriors-num') as HTMLInputElement).value = (
      document.getElementById('cfg-warriors') as HTMLInputElement
    ).value;
    this.setup.map.showList();
    this.sandbox.showValues();
    this.setup.refresh();
    return saved.screen as MenuScreen;
  }
}
