import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { InputHandler } from './InputHandler';
import {
  IUnit,
  IHero,
  UnitType,
  Faction,
  BehaviorState,
  SimConfig,
  DEFAULT_CONFIG,
  BATTLE_CONFIG,
  TerrainDensity,
  TerrainType,
  SideAI,
  LlmModel,
  Objective,
  GRID_SIZE,
} from '../types/types';
import { decodeGrid, listSavedMaps, loadSavedMap, saveMap } from '../state/MapStore';
import { FIXED_MAP } from '../maps/fixedMap';
import { JevController } from '../ai/JevController';
import { LlmController } from '../ai/LlmController';
import { AIController, MatchResult } from '../engine/SimulationEngine';
import { LoadingScreen } from './LoadingScreen';
import { Hud } from './Hud';
import { AiPanel } from './AiPanel';
import { AiSides, MatchLog } from './MatchLog';
import { Sound } from './Sound';
import { icon } from './icons';
import heroWestUrl from '../assets/sprites/hero_knight_gold.png';
import heroEastUrl from '../assets/sprites/hero_shaman_lion.png';
import keySpaceUrl from '../assets/ui/keys/Space.png';
import keyRUrl from '../assets/ui/keys/R.png';
import keyShiftUrl from '../assets/ui/keys/Shift.png';
import keyEscapeUrl from '../assets/ui/keys/Escape.png';
import mouseLeftUrl from '../assets/ui/keys/MouseButtonLeft.png';
import mouseRightUrl from '../assets/ui/keys/MouseButtonRight.png';
import mouseWheelUrl from '../assets/ui/keys/MouseWheelUp.png';

const LS_SPEED = 'sim_speed';
const LS_DEBUG = 'sim_debug';
const LS_EFFECTS = 'sim_effects';
const LS_BARS = 'sim_bars';
const LS_SOUND = 'sim_sound';

// Rows of the Controls screen: key images or key names, then what they do
const HELP: Array<[string[], string]> = [
  [[mouseLeftUrl], 'Select a unit'],
  [[mouseRightUrl], 'Order the selected hero to a point'],
  [[mouseLeftUrl, 'drag'], 'Count the units in an area (zoomed out) or pan (zoomed in)'],
  [[keyShiftUrl, mouseLeftUrl], 'Pan the map'],
  [[mouseWheelUrl], 'Zoom'],
  [[keySpaceUrl], 'Pause / resume'],
  [['+', '−'], 'Faster / slower'],
  [[keyRUrl], 'Restart'],
  [[keyEscapeUrl], 'Menu'],
];

export class UIController {
  private engine: SimulationEngine;
  private stateManager: StateManager;
  private renderer: Renderer;
  private minimapRenderer: MinimapRenderer;
  private inputHandler: InputHandler;
  private loading = new LoadingScreen();
  private hud: Hud;
  private aiPanel = new AiPanel();
  private sound: Sound;
  private aiSides: AiSides = { west: {}, east: {} };
  private matchLog: MatchLog | null = null;
  // Which map the current run uses, for the match log: random, fixed or "saved: <name>"
  private mapChoice: string = 'random';
  private selectedUnitId: string | null = null;
  private debugMode: boolean = false;
  private lastConfig: SimConfig = DEFAULT_CONFIG;
  // A run started from the menu exists (the menu can go back to it)
  private runStarted: boolean = false;
  private pausedBeforeMenu: boolean = false;
  private shownPaused: boolean | null = null;

  // Throttle tooltip updates — only recalculate when cursor moves significantly
  private lastTooltipX: number = -999;
  private lastTooltipY: number = -999;

  private elBtnPause: HTMLButtonElement;
  private elBtnDebug: HTMLButtonElement;
  private elBtnEffects: HTMLButtonElement;
  private elSpeedDisplay: HTMLElement;
  private elTooltip: HTMLElement;
  private elSelectOverlay: HTMLElement;
  private elMainMenu: HTMLElement;
  private elInstructions: HTMLElement;
  private elCanvasArea: HTMLElement;

  constructor(
    engine: SimulationEngine,
    stateManager: StateManager,
    renderer: Renderer,
    minimapRenderer: MinimapRenderer
  ) {
    this.engine = engine;
    this.stateManager = stateManager;
    this.renderer = renderer;
    this.minimapRenderer = minimapRenderer;
    this.inputHandler = new InputHandler('battleCanvas');
    this.hud = new Hud(engine, stateManager, renderer);
    this.sound = new Sound(this.readSetting(LS_SOUND) === 'off');

    this.elBtnPause = document.getElementById('btn-pause') as HTMLButtonElement;
    this.elBtnDebug = document.getElementById('btn-debug') as HTMLButtonElement;
    this.elBtnEffects = document.getElementById('btn-effects') as HTMLButtonElement;
    this.elSpeedDisplay = document.getElementById('speed-display')!;
    this.elTooltip = document.getElementById('tooltip')!;
    this.elSelectOverlay = document.getElementById('select-overlay')!;
    this.elMainMenu = document.getElementById('main-menu')!;
    this.elInstructions = document.getElementById('instructions-overlay')!;
    this.elCanvasArea = document.getElementById('canvas-area')!;

    this.setIcons();
    this.wireSound();
    this.buildHelp();
    this.watchCanvasSize();
    this.loadSettings();
    this.wireMainMenu();
    this.engine.setOnMatchEnd((r) => this.showMatchResult(r));
    this.engine.setOnError((message) => this.showError(message));
    this.wireButtonEvents();
    this.wireInputEvents();
    this.startUIRefresh();
  }

  // --- Page setup ---

  private setIcons(): void {
    const set = (id: string, svg: string) => (document.getElementById(id)!.innerHTML = svg);
    set('btn-slower', icon('slower'));
    set('btn-faster', icon('faster'));
    set('btn-restart', icon('restart'));
    set('btn-save-map', icon('save'));
    set('btn-help', icon('help'));
    document.getElementById('title-west')!.style.backgroundImage = `url(${heroWestUrl})`;
    document.getElementById('title-east')!.style.backgroundImage = `url(${heroEastUrl})`;
    this.updatePauseButton();
  }

  private updatePauseButton(): void {
    const paused = this.engine.isPaused();
    if (paused === this.shownPaused) return;
    this.shownPaused = paused;
    this.elBtnPause.innerHTML = icon(paused ? 'play' : 'pause');
    this.elBtnPause.title = paused ? 'Resume (Space)' : 'Pause (Space)';
  }

  private wireSound(): void {
    this.renderer.setBattleSound((hits, deaths, loudness) =>
      this.sound.battle(hits, deaths, loudness)
    );
    // Audio may only start after a user gesture
    const unlock = () => this.sound.unlock();
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
    // A soft click for buttons in the menus and the top bar
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.btn, .seg button, .icon-btn')) this.sound.play('click');
    });
    const btn = document.getElementById('btn-sound')!;
    const show = () => {
      const muted = this.sound.isMuted();
      btn.innerHTML = icon(muted ? 'soundOff' : 'soundOn');
      btn.title = muted ? 'Sound is off (click to turn on)' : 'Sound is on (click to mute)';
    };
    btn.addEventListener('click', () => {
      this.sound.setMuted(!this.sound.isMuted());
      show();
      this.saveSettings();
    });
    show();
  }

  private buildHelp(): void {
    const table = document.getElementById('help-table')!;
    table.innerHTML = HELP.map(([keys, what]) => {
      const shown = keys
        .map((k) =>
          k.length > 2 && k !== 'drag'
            ? `<img src="${k}" alt="">`
            : `<span class="key-text">${k}</span>`
        )
        .join('');
      return `<tr><td>${shown}</td><td>${what}</td></tr>`;
    }).join('');
  }

  // The battlefield canvas fills its area; the renderer and minimap follow its size.
  private watchCanvasSize(): void {
    const apply = () => {
      const w = this.elCanvasArea.clientWidth;
      const h = this.elCanvasArea.clientHeight;
      if (w <= 0 || h <= 0) return;
      this.renderer.resize(w, h);
      const view = this.renderer.getViewSize();
      this.minimapRenderer.setViewSize(view.width, view.height);
    };
    new ResizeObserver(apply).observe(this.elCanvasArea);
    apply();
  }

  // --- Main menu ---

  private wireMainMenu(): void {
    const config = document.getElementById('menu-config')!;
    const stressInfo = document.getElementById('stress-info')!;
    const battleInfo = document.getElementById('battle-info')!;
    const tabDefault = document.getElementById('tab-default')!;
    const tabCustom = document.getElementById('tab-custom')!;
    const tabStress = document.getElementById('tab-stress')!;
    const tabBattle = document.getElementById('tab-battle')!;
    const warriorSlider = document.getElementById('cfg-warriors') as HTMLInputElement;
    const warriorNum = document.getElementById('cfg-warriors-num') as HTMLInputElement;
    const waveSlider = document.getElementById('cfg-wave-slider') as HTMLInputElement;
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
    const mapSaved = document.getElementById('cfg-map-saved') as HTMLSelectElement;
    document.getElementById('cfg-map')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      this.setOptActive('cfg-map', btn.dataset.val!);
      mapSaved.hidden = btn.dataset.val !== 'saved';
    });
    this.refreshSavedMaps();

    // Battle sides (rules / AI layers), LLM models and AI timing (D4). Model and timing rows
    // only appear when an LLM or any AI is chosen.
    const showAiRows = () => {
      const west = this.getOptActive('cfg-west');
      const east = this.getOptActive('cfg-opponent');
      document.getElementById('row-west-model')!.hidden = !west.includes('llm');
      document.getElementById('row-east-model')!.hidden = !east.includes('llm');
      document.getElementById('row-timing')!.hidden = west === 'none' && east === 'none';
    };
    for (const id of [
      'cfg-west',
      'cfg-opponent',
      'cfg-timing',
      'cfg-west-model',
      'cfg-east-model',
      'cfg-objective',
    ]) {
      document.getElementById(id)!.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button');
        if (!btn) return;
        this.setOptActive(id, btn.dataset.val!);
        showAiRows();
      });
    }

    // Start: set up the run, keep it paused behind the loading screen, then start it
    document.getElementById('menu-start')!.addEventListener('click', async () => {
      if (this.loading.isActive()) return;
      // A saved map that cannot be read must not silently become a random one: paired
      // experiments rely on the map
      if (!tabStress.classList.contains('active') && this.getOptActive('cfg-map') === 'saved') {
        if (!mapSaved.value) {
          window.alert(
            'There is no saved map yet: save one with the "Save this map" button in the top bar first.'
          );
          return;
        }
        if (!loadSavedMap(mapSaved.value)) {
          window.alert(`The saved map "${mapSaved.value}" could not be read. Choose another map.`);
          return;
        }
      }
      this.selectedUnitId = null;
      this.renderer.setSelectedUnit(null);
      this.hud.showUnit(null);
      this.renderer.clearTerrainCache();
      this.minimapRenderer.clearTerrainCache();
      this.closeMenu();

      if (tabStress.classList.contains('active')) {
        // Restart (R) repeats the stress test; no AI layers in classic modes
        this.lastConfig = DEFAULT_CONFIG;
        this.engine.restartStressTest();
        this.startControllers();
      } else {
        const isDefault = tabDefault.classList.contains('active');
        const isBattle = tabBattle.classList.contains('active');
        const base: SimConfig = isBattle
          ? {
              ...BATTLE_CONFIG,
              warriorCount: parseInt(warriorSlider.value),
              terrainDensity: this.getOptActive('cfg-terrain') as TerrainDensity,
              objective: this.getOptActive('cfg-objective') as Objective,
            }
          : isDefault
            ? DEFAULT_CONFIG
            : {
                ...DEFAULT_CONFIG,
                warriorCount: parseInt(warriorSlider.value),
                waveMultiplier: parseFloat(waveSlider.value),
                terrainDensity: this.getOptActive('cfg-terrain') as TerrainDensity,
              };
        const cfg: SimConfig = {
          ...base,
          presetGrid: this.chosenMap(mapSaved.value),
          friendlyAI: isBattle ? (this.getOptActive('cfg-west') as SideAI) : 'none',
          enemyAI: isBattle ? (this.getOptActive('cfg-opponent') as SideAI) : 'none',
          aiTiming: this.getOptActive('cfg-timing') === 'paused' ? 'paused' : 'realtime',
          friendlyModel: this.getOptActive('cfg-west-model') as LlmModel,
          enemyModel: this.getOptActive('cfg-east-model') as LlmModel,
        };
        this.lastConfig = cfg;
        const map = this.getOptActive('cfg-map');
        this.mapChoice = map === 'saved' ? `saved: ${mapSaved.value}` : map;
        this.engine.applyConfig(cfg);
        this.engine.restart();
        // AI controllers tick inside the engine update, so they stay idle while paused
        this.startControllers();
      }
      this.runStarted = true;
      this.hud.reset();
      this.updateSpeedDisplay();

      // restart() unpauses; pause before the first frame so no sim time passes
      this.engine.pause();
      await this.loading.run(
        this.engine.isStressMode() ? 'stress' : this.engine.isBattleMode() ? 'battle' : 'classic'
      );
      this.engine.resume();
      this.sound.play('start');
    });

    document.getElementById('menu-continue')!.addEventListener('click', () => this.closeMenu());

    document.getElementById('menu-instructions')!.addEventListener('click', () => {
      this.elInstructions.style.display = 'flex';
    });

    document.getElementById('btn-close-instructions')!.addEventListener('click', () => {
      this.elInstructions.style.display = 'none';
    });
  }

  private isMenuOpen(): boolean {
    return this.elMainMenu.style.display !== 'none';
  }

  private isHelpOpen(): boolean {
    return this.elInstructions.style.display === 'flex';
  }

  // Opens the menu over the current run, which waits paused behind it.
  private openMenu(): void {
    if (this.isMenuOpen()) return;
    this.pausedBeforeMenu = this.engine.isPaused();
    this.engine.pause();
    document.getElementById('menu-continue')!.hidden = !this.runStarted;
    this.elMainMenu.style.display = 'flex';
  }

  // Back to the run; it resumes only if it was running when the menu opened.
  private closeMenu(): void {
    this.elMainMenu.style.display = 'none';
    if (this.runStarted && !this.pausedBeforeMenu && !this.engine.getResult()) {
      this.engine.resume();
    }
  }

  // Terrain for the chosen map option; undefined means "generate a new random map".
  private chosenMap(savedName: string): TerrainType[][] | undefined {
    const choice = this.getOptActive('cfg-map');
    if (choice === 'fixed') return decodeGrid(FIXED_MAP) ?? undefined;
    if (choice === 'saved' && savedName) return loadSavedMap(savedName) ?? undefined;
    return undefined;
  }

  private refreshSavedMaps(): void {
    const select = document.getElementById('cfg-map-saved') as HTMLSelectElement;
    const names = listSavedMaps();
    select.innerHTML = '';
    for (const name of names) select.add(new Option(name, name));
    if (names.length === 0) select.add(new Option('(no saved maps)', ''));
  }

  // Saves the current terrain under a name so it can be chosen again from the menu.
  private saveCurrentMap(): void {
    const defaultName = `map-${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const name = window.prompt('Save this map as:', defaultName)?.trim();
    if (!name) return;
    // Saving twice within a minute gives the same default name; never replace a map unasked
    if (
      listSavedMaps().includes(name) &&
      !window.confirm(`A map named "${name}" is already saved. Replace it?`)
    )
      return;
    if (!saveMap(name, this.stateManager.getBattlefield().grid)) {
      window.alert('Could not save the map (browser storage is unavailable).');
      return;
    }
    this.refreshSavedMaps();
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

  // --- Button events ---

  private wireButtonEvents(): void {
    this.elBtnPause.addEventListener('click', () => this.togglePause());

    document.getElementById('btn-faster')!.addEventListener('click', () => this.changeSpeed(1));
    document.getElementById('btn-slower')!.addEventListener('click', () => this.changeSpeed(-1));
    document.getElementById('btn-restart')!.addEventListener('click', () => this.doRestart());
    document.getElementById('btn-save-map')!.addEventListener('click', () => this.saveCurrentMap());
    document.getElementById('btn-menu')!.addEventListener('click', () => this.openMenu());
    document.getElementById('btn-help')!.addEventListener('click', () => {
      this.elInstructions.style.display = 'flex';
    });
    document.getElementById('btn-log')!.addEventListener('click', () => this.downloadLog());

    this.elBtnDebug.addEventListener('click', () => {
      this.debugMode = !this.debugMode;
      this.renderer.setDebugMode(this.debugMode);
      this.elBtnDebug.classList.toggle('on', this.debugMode);
      this.saveSettings();
    });

    this.elBtnEffects.addEventListener('click', () => {
      this.renderer.setEffectsEnabled(!this.renderer.isEffectsEnabled());
      this.updateEffectsButton();
      this.saveSettings();
    });

    document.getElementById('btn-bars')!.addEventListener('click', () => {
      this.renderer.setBarsMode(this.renderer.getBarsMode() === 'smart' ? 'all' : 'smart');
      this.updateBarsButton();
      this.saveSettings();
    });
  }

  private togglePause(): void {
    // A finished match stays stopped; restart or the menu starts a new one
    if (this.engine.getResult()) return;
    this.engine.togglePause();
    this.updatePauseButton();
  }

  private changeSpeed(step: 1 | -1): void {
    if (step > 0) this.engine.increaseSpeed();
    else this.engine.decreaseSpeed();
    this.updateSpeedDisplay();
    this.saveSettings();
  }

  private updateBarsButton(): void {
    const all = this.renderer.getBarsMode() === 'all';
    const btn = document.getElementById('btn-bars')!;
    btn.classList.toggle('on', all);
    btn.title = all
      ? 'HP and courage bars over every unit (click: only where something happens)'
      : 'Bars only over units that are hurt, fighting, fleeing or resting, heroes and the selected unit (click: over every unit)';
  }

  private updateEffectsButton(): void {
    const on = this.renderer.isEffectsEnabled();
    this.elBtnEffects.classList.toggle('on', on);
    this.elBtnEffects.title = on
      ? 'Visual effects and sprites are on (click for the original squares)'
      : 'Visual effects are off: original squares (click to turn on)';
  }

  // --- Input events ---

  private wireInputEvents(): void {
    this.inputHandler.onKeyDown((key: string) => {
      // Shortcuts would unpause or restart the run behind the loading screen
      if (this.loading.isActive()) return;
      if (key === 'Escape') {
        if (this.isHelpOpen()) this.elInstructions.style.display = 'none';
        else if (this.isMenuOpen()) {
          if (this.runStarted) this.closeMenu();
        } else this.openMenu();
        return;
      }
      // Game shortcuts only act on the battlefield, not behind the menu or the help screen
      if (this.isMenuOpen() || this.isHelpOpen()) return;
      switch (key) {
        case ' ':
          this.togglePause();
          break;
        case '+':
        case '=':
          this.changeSpeed(1);
          break;
        case '-':
          this.changeSpeed(-1);
          break;
        case 'r':
        case 'R':
          this.doRestart();
          break;
      }
    });

    // Let InputHandler know whether we're zoomed so it picks the right drag mode
    this.inputHandler.setZoomChecker(() => this.renderer.isZoomed());

    // Scroll → zoom
    this.inputHandler.onScroll((delta, x, y) => {
      this.renderer.zoomAt(delta, x, y, true);
    });

    // Drag → pan
    this.inputHandler.onDrag((dx, dy) => {
      this.renderer.pan(dx, dy);
    });

    // Left click → clear task point + select unit (sorted by distance)
    this.inputHandler.onLeftClick((cx, cy) => {
      const hero = this.stateManager.getHero();
      if (hero && !this.engine.isBattleMode()) this.engine.issueCommand(hero, null, 'user');
      const grid = this.renderer.canvasToGrid(cx, cy);
      const nearby = this.stateManager.getUnitsInRadius(grid.x, grid.y, 2);
      nearby.sort((a, b) => {
        const dxa = a.position.x - grid.x;
        const dya = a.position.y - grid.y;
        const dxb = b.position.x - grid.x;
        const dyb = b.position.y - grid.y;
        return dxa * dxa + dya * dya - (dxb * dxb + dyb * dyb);
      });
      const clicked = nearby[0] ?? null;
      this.selectedUnitId = clicked?.id ?? null;
      this.renderer.setSelectedUnit(this.selectedUnitId);
      this.hud.showUnit(clicked);
    });

    // Right click → task point for the selected friendly hero, or the first one
    this.inputHandler.onRightClick((cx, cy) => {
      const grid = this.renderer.canvasToGrid(cx, cy);
      // Orders outside the map would send the hero to an unreachable point
      if (grid.x < 0 || grid.y < 0 || grid.x >= GRID_SIZE || grid.y >= GRID_SIZE) return;
      const hero = this.commandableHero();
      if (hero) {
        this.engine.issueCommand(hero, { type: 'move', target: { x: grid.x, y: grid.y } }, 'user');
        this.sound.play('order');
      }
    });

    // Hover → tooltip
    this.inputHandler.onHover((cx, cy) => {
      if (Math.abs(cx - this.lastTooltipX) < 5 && Math.abs(cy - this.lastTooltipY) < 5) return;
      this.lastTooltipX = cx;
      this.lastTooltipY = cy;
      this.updateTooltip(cx, cy);
    });

    // Leave canvas → hide tooltip; a selection drag that leaves the canvas is cancelled
    this.inputHandler.onCanvasLeave(() => {
      this.elTooltip.style.display = 'none';
      this.elSelectOverlay.style.display = 'none';
      this.lastTooltipX = this.lastTooltipY = -999;
    });

    // Drag at full zoom → show selection rectangle
    this.inputHandler.onSelectDrag((x1, y1, x2, y2) => {
      this.showSelectOverlay(x1, y1, x2, y2);
    });

    // Selection drag end → show area stats
    this.inputHandler.onSelectDragEnd((x1, y1, x2, y2) => {
      this.elSelectOverlay.style.display = 'none';
      this.showSelectStats(x1, y1, x2, y2);
    });

    // Minimap click → center main view on that tile
    const minimapEl = document.getElementById('minimapCanvas') as HTMLCanvasElement;
    minimapEl.addEventListener('click', (e: MouseEvent) => {
      const r = minimapEl.getBoundingClientRect();
      const tileX = ((e.clientX - r.left) / r.width) * GRID_SIZE;
      const tileY = ((e.clientY - r.top) / r.height) * GRID_SIZE;
      this.renderer.centerOn(tileX, tileY, true);
    });
  }

  // --- Tooltip ---

  private updateTooltip(cx: number, cy: number): void {
    const grid = this.renderer.canvasToGrid(cx, cy);
    const nearby = this.stateManager.getUnitsInRadius(grid.x, grid.y, 1.5);

    if (nearby.length === 0) {
      this.elTooltip.style.display = 'none';
      return;
    }

    // Find the closest unit to cursor
    let closest = nearby[0];
    let minD2 = Infinity;
    for (const u of nearby) {
      const dx = u.position.x - grid.x;
      const dy = u.position.y - grid.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) {
        minD2 = d2;
        closest = u;
      }
    }

    const battle = this.engine.isBattleMode();
    const stateLabel =
      closest.state === BehaviorState.IDLE && closest.path.length > 0
        ? 'Moving'
        : (['Standing', 'Moving', 'Fighting', 'Fleeing', 'Resting'][closest.state] ??
          BehaviorState[closest.state]);
    const side = battle ? `${closest.faction === Faction.FRIENDLY ? 'West' : 'East'} ` : '';
    const kind =
      closest.unitType === UnitType.HERO
        ? `hero ${(closest as IHero).heroIndex}`
        : battle
          ? 'soldier'
          : UnitType[closest.unitType].toLowerCase();
    this.elTooltip.innerHTML =
      `<span class="${closest.faction === Faction.FRIENDLY ? 'west' : 'east'}-text">${side}${kind}</span><br>` +
      `HP ${Math.ceil(closest.hp)}/${closest.maxHp}<br>` +
      `<span class="dim">${stateLabel}</span>`;

    // Position near the cursor; flip to the other side near the right or bottom edge
    this.elTooltip.style.display = 'block';
    const tw = this.elTooltip.offsetWidth;
    const th = this.elTooltip.offsetHeight;
    const { width, height } = this.renderer.getViewSize();
    const tipX = cx + 16 + tw > width ? cx - tw - 12 : cx + 16;
    const tipY = Math.max(0, Math.min(height - th, cy - 12));
    this.elTooltip.style.left = `${tipX}px`;
    this.elTooltip.style.top = `${tipY}px`;
  }

  // --- Drag-select overlay ---

  private showSelectOverlay(x1: number, y1: number, x2: number, y2: number): void {
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    this.elSelectOverlay.style.left = `${left}px`;
    this.elSelectOverlay.style.top = `${top}px`;
    this.elSelectOverlay.style.width = `${w}px`;
    this.elSelectOverlay.style.height = `${h}px`;
    this.elSelectOverlay.style.display = 'block';
  }

  private commandableHero(): IHero | undefined {
    const selected = this.selectedUnitId
      ? this.stateManager.getUnitById(this.selectedUnitId)
      : undefined;
    if (
      selected &&
      selected.unitType === UnitType.HERO &&
      selected.faction === Faction.FRIENDLY &&
      (selected as IHero).controller === 'user'
    ) {
      return selected as IHero;
    }
    const first = this.stateManager.getHero();
    return first?.controller === 'user' ? first : undefined;
  }

  private showSelectStats(x1: number, y1: number, x2: number, y2: number): void {
    const g1 = this.renderer.canvasToGrid(Math.min(x1, x2), Math.min(y1, y2));
    const g2 = this.renderer.canvasToGrid(Math.max(x1, x2), Math.max(y1, y2));
    const inside: IUnit[] = [];
    for (const u of this.stateManager.getBattlefield().units) {
      if (u.position.x < g1.x || u.position.x > g2.x) continue;
      if (u.position.y < g1.y || u.position.y > g2.y) continue;
      inside.push(u);
    }
    this.hud.showArea(inside);
  }

  // --- LocalStorage ---

  // Storage can be unavailable (private windows, blocked site data); settings then stay
  // at their defaults for this session.
  private readSetting(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private loadSettings(): void {
    const read = (key: string) => this.readSetting(key);
    const speed = read(LS_SPEED);
    if (speed) {
      const parsed = parseFloat(speed) as 0.5 | 1 | 2 | 4;
      if ([0.5, 1, 2, 4].includes(parsed)) {
        this.engine.setSpeed(parsed);
        this.updateSpeedDisplay();
      }
    }

    if (read(LS_DEBUG) === 'true') {
      this.debugMode = true;
      this.renderer.setDebugMode(true);
      this.elBtnDebug.classList.add('on');
    }

    // Effects default to on; only an explicit 'false' turns them off
    this.renderer.setEffectsEnabled(read(LS_EFFECTS) !== 'false');
    this.updateEffectsButton();
    this.renderer.setBarsMode(read(LS_BARS) === 'all' ? 'all' : 'smart');
    this.updateBarsButton();
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(LS_SPEED, this.engine.getSpeed().toString());
      localStorage.setItem(LS_DEBUG, this.debugMode.toString());
      localStorage.setItem(LS_EFFECTS, this.renderer.isEffectsEnabled().toString());
      localStorage.setItem(LS_BARS, this.renderer.getBarsMode());
      localStorage.setItem(LS_SOUND, this.sound.isMuted() ? 'off' : 'on');
    } catch {
      // Storage unavailable: settings last for this session only
    }
  }

  // Battle mode: shown when the match is decided.
  private showMatchResult(r: MatchResult): void {
    // The player hears a win or a loss for their own side; a spectator hears the end of a
    // decided match, and a draw sounds like a loss
    const playerSide = (this.lastConfig.friendlyAI ?? 'none') === 'none' ? Faction.FRIENDLY : null;
    const won = r.winner !== null && (playerSide === null || r.winner === playerSide);
    this.sound.play(won ? 'victory' : 'defeat');
    this.hud.showResult(r, this.lastConfig, {
      restart: () => this.doRestart(),
      menu: () => this.openMenu(),
      log: () => this.downloadLog(),
    });
    this.updatePauseButton();
  }

  // A simulation error stopped the run: say so instead of leaving a frozen battlefield.
  private showError(message: string): void {
    this.hud.showError(message, this.stateManager.getBattlefield().elapsedTime, {
      restart: () => this.doRestart(),
      menu: () => this.openMenu(),
      log: this.matchLog ? () => this.downloadLog() : null,
    });
    this.updatePauseButton();
  }

  private downloadLog(): void {
    this.matchLog?.download(this.stateManager, this.engine.getResult(), this.engine.getError());
  }

  // Attaches the AI layers chosen for each side of this match and starts its match log.
  // Restart clears them, so this runs after every engine.restart(). Running controllers are
  // exposed as window.ai.west / window.ai.east ({ jev, llm }) for inspection in the console.
  private startControllers(): void {
    this.hud.hideResult();
    this.aiSides = { west: {}, east: {} };
    const debug = window as unknown as { ai?: AiSides };
    debug.ai = this.aiSides;
    const battle = this.lastConfig.mode === 'battle' && !this.engine.isStressMode();
    this.matchLog = battle ? new MatchLog(this.lastConfig, this.mapChoice, this.aiSides) : null;
    document.getElementById('btn-log')!.hidden = !battle;
    if (!battle) return;

    const controllers: AIController[] = [];
    const sides: Array<[Faction, SideAI, 'west' | 'east', LlmModel]> = [
      [
        Faction.FRIENDLY,
        this.lastConfig.friendlyAI ?? 'none',
        'west',
        this.lastConfig.friendlyModel ?? 'sonnet',
      ],
      [
        Faction.ENEMY,
        this.lastConfig.enemyAI ?? 'none',
        'east',
        this.lastConfig.enemyModel ?? 'sonnet',
      ],
    ];
    for (const [faction, ai, name, model] of sides) {
      if (ai === 'none') continue;
      // The LLM commands the side; with Jev it is the LLM's tactical layer (Jev alone was
      // dropped: it sees only each hero's surroundings)
      const both = ai === 'jev+llm';
      const side = this.aiSides[name];
      if (both) {
        side.jev = new JevController(this.engine, this.stateManager, faction, {
          fallbackToRules: false,
          withCommander: true,
        });
        controllers.push(side.jev);
      }
      side.llm = new LlmController(this.engine, this.stateManager, faction, {
        model,
        fallbackToRules: !both,
        jevAssessment: side.jev ? (heroIndex) => side.jev!.assessmentFor(heroIndex) : null,
      });
      controllers.push(side.llm);
    }
    this.engine.setControllers(controllers);
  }

  // --- Restart ---

  private doRestart(): void {
    if (this.loading.isActive()) return;
    this.selectedUnitId = null;
    this.renderer.setSelectedUnit(null);
    this.hud.showUnit(null);
    this.renderer.clearTerrainCache();
    this.minimapRenderer.clearTerrainCache();
    // Restarting a stress test runs the stress test again (it used to restart as Default)
    if (this.engine.isStressMode()) this.engine.restartStressTest();
    else {
      this.engine.applyConfig(this.lastConfig);
      this.engine.restart();
    }
    this.startControllers();
    this.hud.reset();
    this.updatePauseButton();
    this.updateSpeedDisplay();
  }

  private updateSpeedDisplay(): void {
    this.elSpeedDisplay.textContent = `${this.engine.getSpeed()}x`;
  }

  private startUIRefresh(): void {
    setInterval(() => {
      this.hud.update(this.lastConfig);
      this.matchLog?.sample(this.stateManager);
      this.aiPanel.update(
        this.aiSides,
        this.lastConfig,
        this.stateManager.getBattlefield().elapsedTime,
        this.stateManager.getHeroes()
      );
      this.updatePauseButton();
      if (this.selectedUnitId) {
        const unit = this.stateManager.getUnitById(this.selectedUnitId);
        this.hud.showUnit(unit ?? null);
        if (!unit) {
          this.selectedUnitId = null;
          this.renderer.setSelectedUnit(null);
        }
      }
    }, 100);
  }
}
