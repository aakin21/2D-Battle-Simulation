import {
  SimConfig,
  DEFAULT_CONFIG,
  BATTLE_CONFIG,
  TerrainDensity,
  TerrainType,
  SideAI,
  LlmModel,
  TacticalModel,
  Objective,
} from '../types/types';
import { decodeGrid, listSavedMaps, loadSavedMap, saveMap } from '../state/MapStore';
import { FIXED_MAP } from '../maps/fixedMap';
import { isOpenRouterId, OPENROUTER_MODELS } from '../ai/Models';
import { Dropdown } from './Dropdown';

type Side = 'west' | 'east';

// Each side's "who commands it" button group in the menu
const SIDE_GROUPS = [
  ['west', 'cfg-west'],
  ['east', 'cfg-opponent'],
] as const;

// What Start runs: the stress test, or a run from these settings. `mapChoice` names the map for
// the match log: random, fixed or "saved: <name>".
export type StartChoice = { kind: 'stress' } | { kind: 'run'; cfg: SimConfig; mapChoice: string };

// The main menu's settings: tabs (Default / Custom / Stress / Battle), sliders, map choice, who
// commands each side, the LLM and its provider, AI timing. Start, Continue and the Controls
// buttons are wired by UIController.
export class MainMenu {
  private tabDefault = document.getElementById('tab-default')!;
  private tabCustom = document.getElementById('tab-custom')!;
  private tabStress = document.getElementById('tab-stress')!;
  private tabBattle = document.getElementById('tab-battle')!;
  private warriorSlider = document.getElementById('cfg-warriors') as HTMLInputElement;
  private waveSlider = document.getElementById('cfg-wave-slider') as HTMLInputElement;
  private mapSaved = document.getElementById('cfg-map-saved') as HTMLSelectElement;
  private routerLists = {} as Record<Side, Dropdown>; // OpenRouter model lists (D52)

  constructor() {
    const config = document.getElementById('menu-config')!;
    const stressInfo = document.getElementById('stress-info')!;
    const battleInfo = document.getElementById('battle-info')!;
    const { tabDefault, tabCustom, tabStress, tabBattle, warriorSlider, waveSlider } = this;
    const warriorNum = document.getElementById('cfg-warriors-num') as HTMLInputElement;
    const waveVal = document.getElementById('cfg-wave-val')!;

    const setTab = (active: HTMLElement) => {
      [tabDefault, tabCustom, tabStress, tabBattle].forEach((t) => t.classList.remove('active'));
      active.classList.add('active');
      const isStress = active === tabStress;
      const isCustom = active === tabCustom;
      const isBattle = active === tabBattle;
      // Battle uses the soldier count (per side) and terrain settings, but not waves.
      config.classList.toggle('locked', !isCustom && !isBattle);
      config.hidden = isStress;
      document.getElementById('cfg-wave-row')!.hidden = isBattle;
      document.getElementById('cfg-warriors-label')!.textContent = isBattle
        ? 'Soldiers'
        : 'Warriors';
      document.getElementById('cfg-army-title')!.textContent = isBattle
        ? 'Army (per side)'
        : 'Army';
      stressInfo.hidden = !isStress;
      battleInfo.hidden = !isBattle;
    };

    tabDefault.addEventListener('click', () => {
      setTab(tabDefault);
      warriorSlider.value = '300';
      warriorNum.value = '300';
      waveSlider.value = '1';
      waveVal.textContent = '1×';
      this.setOptActive('cfg-terrain', 'normal');
    });

    tabCustom.addEventListener('click', () => setTab(tabCustom));
    tabStress.addEventListener('click', () => setTab(tabStress));
    tabBattle.addEventListener('click', () => {
      setTab(tabBattle);
      warriorSlider.value = String(BATTLE_CONFIG.warriorCount);
      warriorNum.value = String(BATTLE_CONFIG.warriorCount);
    });

    // Warrior slider + number input — keep in sync
    warriorSlider.addEventListener('input', () => {
      warriorNum.value = warriorSlider.value;
    });
    warriorNum.addEventListener('input', () => {
      const v = Math.min(2000, Math.max(0, parseInt(warriorNum.value) || 0));
      warriorSlider.value = v.toString();
    });
    // Show the clamped value once editing is done (clamping while typing would fight the user)
    warriorNum.addEventListener('change', () => {
      warriorNum.value = warriorSlider.value;
    });

    // Wave size slider
    waveSlider.addEventListener('input', () => {
      waveVal.textContent = `${waveSlider.value}×`;
    });

    // Terrain buttons
    document.getElementById('cfg-terrain')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (btn) this.setOptActive('cfg-terrain', btn.dataset.val!);
    });

    // Map buttons (D5): Random / Fixed / Saved
    document.getElementById('cfg-map')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      this.setOptActive('cfg-map', btn.dataset.val!);
      this.mapSaved.hidden = btn.dataset.val !== 'saved';
    });
    this.refreshSavedMaps();

    // Battle sides: the user or rules, the LLM alone, or the LLM with Jev or SubQ Snap as its
    // tactical layer (D38, D51); how the LLM is reached and which model (D29, D52); AI timing
    // (D4). Each row only appears when it applies.
    const showAiRows = () => {
      for (const [side, groupId] of SIDE_GROUPS) {
        const llm = this.getOptActive(groupId).includes('llm');
        const router = this.getOptActive(`cfg-${side}-provider`) === 'openrouter';
        const custom = this.routerLists[side].value === '';
        document.getElementById(`row-${side}-provider`)!.hidden = !llm;
        document.getElementById(`row-${side}-model`)!.hidden = !llm || router;
        document.getElementById(`row-${side}-router`)!.hidden = !llm || !router;
        document.getElementById(`cfg-${side}-router-id`)!.hidden = !custom;
      }
      const west = this.getOptActive('cfg-west');
      const east = this.getOptActive('cfg-opponent');
      document.getElementById('row-timing')!.hidden = west === 'none' && east === 'none';
    };
    for (const side of ['west', 'east'] as const) {
      this.routerLists[side] = this.routerList(side);
      this.routerLists[side].onChoose(() => {
        showAiRows();
        if (this.routerLists[side].value === '')
          (document.getElementById(`cfg-${side}-router-id`) as HTMLInputElement).focus();
      });
    }
    for (const id of [
      'cfg-west',
      'cfg-opponent',
      'cfg-timing',
      'cfg-replay',
      'cfg-west-model',
      'cfg-east-model',
      'cfg-west-provider',
      'cfg-east-provider',
      'cfg-objective',
    ]) {
      document.getElementById(id)!.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button');
        if (!btn) return;
        this.setOptActive(id, btn.dataset.val!);
        showAiRows();
      });
    }
  }

  // Reads the menu for Start. Settings that cannot run as chosen are explained in an alert and
  // give null: the menu stays open.
  readStart(): StartChoice | null {
    const mapSaved = this.mapSaved;
    // A saved map that cannot be read must not silently become a random one: paired
    // experiments rely on the map
    if (!this.tabStress.classList.contains('active') && this.getOptActive('cfg-map') === 'saved') {
      if (!mapSaved.value) {
        window.alert(
          'There is no saved map yet: save one with the "Save this map" button in the top bar first.'
        );
        return null;
      }
      if (!loadSavedMap(mapSaved.value)) {
        window.alert(`The saved map "${mapSaved.value}" could not be read. Choose another map.`);
        return null;
      }
    }
    // A mistyped OpenRouter id must not silently run another model: model comparisons rely on it
    if (this.tabBattle.classList.contains('active')) {
      for (const [side, groupId] of SIDE_GROUPS) {
        const llm = this.getOptActive(groupId).includes('llm');
        if (
          llm &&
          this.getOptActive(`cfg-${side}-provider`) === 'openrouter' &&
          !this.routerId(side)
        ) {
          window.alert(
            `Type the ${side === 'west' ? 'West' : 'East'} model's OpenRouter id, e.g. "google/gemini-3.8-flash".`
          );
          return null;
        }
      }
    }

    if (this.tabStress.classList.contains('active')) return { kind: 'stress' };

    const isDefault = this.tabDefault.classList.contains('active');
    const isBattle = this.tabBattle.classList.contains('active');
    const base: SimConfig = isBattle
      ? {
          ...BATTLE_CONFIG,
          warriorCount: parseInt(this.warriorSlider.value),
          terrainDensity: this.getOptActive('cfg-terrain') as TerrainDensity,
          objective: this.getOptActive('cfg-objective') as Objective,
        }
      : isDefault
        ? DEFAULT_CONFIG
        : {
            ...DEFAULT_CONFIG,
            warriorCount: parseInt(this.warriorSlider.value),
            waveMultiplier: parseFloat(this.waveSlider.value),
            terrainDensity: this.getOptActive('cfg-terrain') as TerrainDensity,
          };
    const cfg: SimConfig = {
      ...base,
      presetGrid: this.chosenMap(mapSaved.value),
      friendlyAI: isBattle ? this.sideAi('cfg-west') : 'none',
      enemyAI: isBattle ? this.sideAi('cfg-opponent') : 'none',
      aiTiming: this.getOptActive('cfg-timing') === 'paused' ? 'paused' : 'realtime',
      recordReplay: this.getOptActive('cfg-replay') !== 'off',
      friendlyModel: this.chosenModel('west'),
      enemyModel: this.chosenModel('east'),
      friendlyTactical: this.tacticalModel('cfg-west'),
      enemyTactical: this.tacticalModel('cfg-opponent'),
    };
    const map = this.getOptActive('cfg-map');
    const mapChoice = map === 'saved' ? `saved: ${mapSaved.value}` : map;
    return { kind: 'run', cfg, mapChoice };
  }

  // Saves the current terrain under a name so it can be chosen again from the menu.
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
    this.refreshSavedMaps();
  }

  private refreshSavedMaps(): void {
    const select = this.mapSaved;
    const names = listSavedMaps();
    select.innerHTML = '';
    for (const name of names) select.add(new Option(name, name));
    if (names.length === 0) select.add(new Option('(no saved maps)', ''));
  }

  // Terrain for the chosen map option; undefined means "generate a new random map".
  private chosenMap(savedName: string): TerrainType[][] | undefined {
    const choice = this.getOptActive('cfg-map');
    if (choice === 'fixed') return decodeGrid(FIXED_MAP) ?? undefined;
    if (choice === 'saved' && savedName) return loadSavedMap(savedName) ?? undefined;
    return undefined;
  }

  // The OpenRouter models of the menu, grouped by company, then a free id (D52)
  private routerList(side: Side): Dropdown {
    const items = [
      ...OPENROUTER_MODELS.map((m) => ({ value: m.id, label: m.label, group: m.company })),
      { value: '', label: 'Other model id…', group: 'Other' },
    ];
    const root = document.getElementById(`cfg-${side}-router`)!;
    return new Dropdown(root, items, 'anthropic/claude-sonnet-5.5');
  }

  // A side's choice in the menu: "LLM + Snap" is the LLM with Snap as its tactical layer (D51)
  private sideAi(groupId: string): SideAI {
    const v = this.getOptActive(groupId);
    return v === 'snap+llm' ? 'jev+llm' : (v as SideAI);
  }

  private tacticalModel(groupId: string): TacticalModel {
    return this.getOptActive(groupId) === 'snap+llm' ? 'snap' : 'jev';
  }

  // The LLM chosen for a side: a Claude alias, or "openrouter:<id>" (D52). A typed id that is not
  // an OpenRouter id falls back to the list's first model; Start checks it first.
  private chosenModel(side: Side): LlmModel {
    if (this.getOptActive(`cfg-${side}-provider`) !== 'openrouter')
      return this.getOptActive(`cfg-${side}-model`) as LlmModel;
    return `openrouter:${this.routerId(side) ?? OPENROUTER_MODELS[0].id}`;
  }

  private routerId(side: Side): string | null {
    const picked = this.routerLists[side].value;
    const id =
      picked || (document.getElementById(`cfg-${side}-router-id`) as HTMLInputElement).value.trim();
    return isOpenRouterId(id) ? id : null;
  }

  private setOptActive(groupId: string, val: string): void {
    const group = document.getElementById(groupId)!;
    group.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLButtonElement).dataset.val === val);
    });
  }

  private getOptActive(groupId: string): string {
    const active = document
      .getElementById(groupId)!
      .querySelector('button.active') as HTMLButtonElement | null;
    return active?.dataset.val ?? '';
  }
}
