import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { InputHandler } from './InputHandler';
import { IUnit, UnitType, BehaviorState, SimConfig, DEFAULT_CONFIG, TerrainDensity } from '../types/types';

const LS_SPEED = 'sim_speed';
const LS_DEBUG = 'sim_debug';

export class UIController {
  private engine: SimulationEngine;
  private stateManager: StateManager;
  private renderer: Renderer;
  private minimapRenderer: MinimapRenderer;
  private inputHandler: InputHandler;
  private selectedUnitId: string | null = null;
  private debugMode: boolean = false;
  private lastConfig: SimConfig = DEFAULT_CONFIG;

  // Throttle tooltip updates — only recalculate when cursor moves significantly
  private lastTooltipX: number = -999;
  private lastTooltipY: number = -999;

  private elBtnPause: HTMLButtonElement;
  private elBtnFaster: HTMLButtonElement;
  private elBtnSlower: HTMLButtonElement;
  private elBtnRestart: HTMLButtonElement;
  private elBtnMenu: HTMLButtonElement;
  private elBtnDebug: HTMLButtonElement;
  private elSpeedDisplay: HTMLElement;
  private elWaveCounter: HTMLElement;
  private elWarriorCount: HTMLElement;
  private elBerserkerCount: HTMLElement;
  private elElapsedTime: HTMLElement;
  private elUnitType: HTMLElement;
  private elUnitHp: HTMLElement;
  private elUnitCourage: HTMLElement;
  private elUnitState: HTMLElement;
  private elTooltip: HTMLElement;
  private elSelectOverlay: HTMLElement;
  private elAreaStatContent: HTMLElement;
  private elMainMenu: HTMLElement;
  private elInstructions: HTMLElement;

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

    this.elBtnPause = document.getElementById('btn-pause') as HTMLButtonElement;
    this.elBtnFaster = document.getElementById('btn-faster') as HTMLButtonElement;
    this.elBtnSlower = document.getElementById('btn-slower') as HTMLButtonElement;
    this.elBtnRestart = document.getElementById('btn-restart') as HTMLButtonElement;
    this.elBtnMenu = document.getElementById('btn-menu') as HTMLButtonElement;
    this.elBtnDebug = document.getElementById('btn-debug') as HTMLButtonElement;
    this.elSpeedDisplay = document.getElementById('speed-display')!;
    this.elWaveCounter = document.getElementById('wave-counter')!;
    this.elWarriorCount = document.getElementById('warrior-count')!;
    this.elBerserkerCount = document.getElementById('berserker-count')!;
    this.elElapsedTime = document.getElementById('elapsed-time')!;
    this.elUnitType = document.getElementById('unit-type')!;
    this.elUnitHp = document.getElementById('unit-hp')!;
    this.elUnitCourage = document.getElementById('unit-courage')!;
    this.elUnitState = document.getElementById('unit-state')!;
    this.elTooltip = document.getElementById('tooltip')!;
    this.elSelectOverlay = document.getElementById('select-overlay')!;
    this.elAreaStatContent = document.getElementById('stat-content')!;
    this.elMainMenu = document.getElementById('main-menu')!;
    this.elInstructions = document.getElementById('instructions-overlay')!;

    this.loadSettings();
    this.wireMainMenu();
    this.wireButtonEvents();
    this.wireInputEvents();
    this.startUIRefresh();
  }

  // --- Main menu ---

  private wireMainMenu(): void {
    const config = document.getElementById('menu-config')!;
    const stressInfo = document.getElementById('stress-info')!;
    const tabDefault = document.getElementById('tab-default')!;
    const tabCustom = document.getElementById('tab-custom')!;
    const tabStress = document.getElementById('tab-stress')!;
    const warriorSlider = document.getElementById('cfg-warriors') as HTMLInputElement;
    const warriorNum = document.getElementById('cfg-warriors-num') as HTMLInputElement;
    const waveSlider = document.getElementById('cfg-wave-slider') as HTMLInputElement;
    const waveVal = document.getElementById('cfg-wave-val')!;

    const setTab = (active: HTMLElement) => {
      [tabDefault, tabCustom, tabStress].forEach(t => t.classList.remove('active'));
      active.classList.add('active');
      const isStress = active === tabStress;
      const isCustom = active === tabCustom;
      config.classList.toggle('locked', !isCustom);
      stressInfo.style.display = isStress ? 'block' : 'none';
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

    // Warrior slider + number input — keep in sync
    warriorSlider.addEventListener('input', () => {
      warriorNum.value = warriorSlider.value;
    });
    warriorNum.addEventListener('input', () => {
      const v = Math.min(2000, Math.max(0, parseInt(warriorNum.value) || 0));
      warriorSlider.value = v.toString();
      warriorNum.value = v.toString();
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

    // Start
    document.getElementById('menu-start')!.addEventListener('click', () => {
      this.selectedUnitId = null;
      this.renderer.setSelectedUnit(null);
      this.renderer.clearTerrainCache();
      this.minimapRenderer.clearTerrainCache();
      this.elMainMenu.style.display = 'none';
      this.elBtnPause.textContent = 'Pause';

      if (tabStress.classList.contains('active')) {
        this.engine.restartStressTest();
        return;
      }

      const isDefault = tabDefault.classList.contains('active');
      const cfg: SimConfig = isDefault ? DEFAULT_CONFIG : {
        warriorCount: parseInt(warriorSlider.value),
        waveMultiplier: parseFloat(waveSlider.value),
        terrainDensity: this.getOptActive('cfg-terrain') as TerrainDensity,
      };
      this.lastConfig = cfg;
      this.engine.applyConfig(cfg);
      this.engine.restart();
      this.updateSpeedDisplay();
    });

    document.getElementById('menu-instructions')!.addEventListener('click', () => {
      this.elInstructions.style.display = 'flex';
    });

    document.getElementById('btn-close-instructions')!.addEventListener('click', () => {
      this.elInstructions.style.display = 'none';
    });
  }

  private setOptActive(groupId: string, val: string): void {
    const group = document.getElementById(groupId)!;
    group.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLButtonElement).dataset.val === val);
    });
  }

  private getOptActive(groupId: string): string {
    const active = document.getElementById(groupId)!.querySelector('button.active') as HTMLButtonElement | null;
    return active?.dataset.val ?? '';
  }

  // --- Button events ---

  private wireButtonEvents(): void {
    this.elBtnPause.addEventListener('click', () => {
      this.engine.togglePause();
      this.elBtnPause.textContent = this.engine.isPaused() ? 'Resume' : 'Pause';
    });

    this.elBtnFaster.addEventListener('click', () => {
      this.engine.increaseSpeed();
      this.updateSpeedDisplay();
      this.saveSettings();
    });

    this.elBtnSlower.addEventListener('click', () => {
      this.engine.decreaseSpeed();
      this.updateSpeedDisplay();
      this.saveSettings();
    });

    this.elBtnRestart.addEventListener('click', () => this.doRestart());

    this.elBtnMenu.addEventListener('click', () => {
      this.engine.pause();
      this.elBtnPause.textContent = 'Resume';
      this.elMainMenu.style.display = 'flex';
    });

    this.elBtnDebug.addEventListener('click', () => {
      this.debugMode = !this.debugMode;
      this.renderer.setDebugMode(this.debugMode);
      this.elBtnDebug.style.color = this.debugMode ? '#00ff88' : '';
      this.saveSettings();
    });
  }

  // --- Input events ---

  private wireInputEvents(): void {
    this.inputHandler.onKeyDown((key: string) => {
      switch (key) {
        case ' ':
          this.engine.togglePause();
          this.elBtnPause.textContent = this.engine.isPaused() ? 'Resume' : 'Pause';
          break;
        case '+':
        case '=':
          this.engine.increaseSpeed();
          this.updateSpeedDisplay();
          this.saveSettings();
          break;
        case '-':
          this.engine.decreaseSpeed();
          this.updateSpeedDisplay();
          this.saveSettings();
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
      this.renderer.zoomAt(delta, x, y);
    });

    // Drag → pan
    this.inputHandler.onDrag((dx, dy) => {
      this.renderer.pan(dx, dy);
    });

    // Left click → clear task point + select unit (sorted by distance)
    this.inputHandler.onLeftClick((cx, cy) => {
      const hero = this.stateManager.getHero();
      if (hero) hero.taskPoint = null;
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
      this.updateInfoPanel(clicked);
    });

    // Right click → hero task point
    this.inputHandler.onRightClick((cx, cy) => {
      const grid = this.renderer.canvasToGrid(cx, cy);
      const hero = this.stateManager.getHero();
      if (hero) hero.taskPoint = { x: grid.x, y: grid.y };
    });

    // Hover → tooltip
    this.inputHandler.onHover((cx, cy) => {
      if (Math.abs(cx - this.lastTooltipX) < 5 && Math.abs(cy - this.lastTooltipY) < 5) return;
      this.lastTooltipX = cx;
      this.lastTooltipY = cy;
      this.updateTooltip(cx, cy);
    });

    // Leave canvas → hide tooltip
    this.inputHandler.onCanvasLeave(() => {
      this.elTooltip.style.display = 'none';
    });

    // Shift + drag → show selection rectangle
    this.inputHandler.onSelectDrag((x1, y1, x2, y2) => {
      this.showSelectOverlay(x1, y1, x2, y2);
    });

    // Shift + drag end → show area stats
    this.inputHandler.onSelectDragEnd((x1, y1, x2, y2) => {
      this.elSelectOverlay.style.display = 'none';
      this.showSelectStats(x1, y1, x2, y2);
    });

    // Minimap click → center main view on that tile
    const minimapEl = document.getElementById('minimapCanvas') as HTMLCanvasElement;
    minimapEl.addEventListener('click', (e: MouseEvent) => {
      const r = minimapEl.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      // Minimap is GRID_SIZE × GRID_SIZE pixels covering the full 150×150 tile grid
      const tileX = (mx / r.width) * 150;
      const tileY = (my / r.height) * 150;
      this.renderer.centerOn(tileX, tileY);
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

    const stateLabel =
      closest.state === BehaviorState.IDLE && closest.path.length > 0
        ? 'MOVING'
        : BehaviorState[closest.state];

    this.elTooltip.innerHTML =
      `${UnitType[closest.unitType]}<br>` +
      `HP ${Math.ceil(closest.hp)}/${closest.maxHp}<br>` +
      stateLabel;

    // Position near cursor, flip left if too close to right edge of canvas
    const tipX = cx > 660 ? cx - 90 : cx + 14;
    this.elTooltip.style.left = `${tipX}px`;
    this.elTooltip.style.top = `${Math.max(0, cy - 12)}px`;
    this.elTooltip.style.display = 'block';
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

  private showSelectStats(x1: number, y1: number, x2: number, y2: number): void {
    const g1 = this.renderer.canvasToGrid(Math.min(x1, x2), Math.min(y1, y2));
    const g2 = this.renderer.canvasToGrid(Math.max(x1, x2), Math.max(y1, y2));

    let warriors = 0;
    let berserkers = 0;
    let heroes = 0;
    for (const u of this.stateManager.getBattlefield().units) {
      if (u.position.x < g1.x || u.position.x > g2.x) continue;
      if (u.position.y < g1.y || u.position.y > g2.y) continue;
      if (u.unitType === UnitType.WARRIOR) warriors++;
      else if (u.unitType === UnitType.BERSERKER) berserkers++;
      else if (u.unitType === UnitType.HERO) heroes++;
    }

    const total = warriors + berserkers + heroes;
    this.elAreaStatContent.innerHTML =
      `<span class="stat-w">Warrior: ${warriors}</span><br>` +
      `<span class="stat-b">Berserker: ${berserkers}</span><br>` +
      `<span class="stat-h">Hero: ${heroes}</span><br>` +
      `<span class="stat-total">Total: ${total}</span>`;
  }

  // --- LocalStorage ---

  private loadSettings(): void {
    const speed = localStorage.getItem(LS_SPEED);
    if (speed) {
      const parsed = parseFloat(speed) as 0.5 | 1 | 2 | 4;
      if ([0.5, 1, 2, 4].includes(parsed)) {
        this.engine.setSpeed(parsed);
        this.updateSpeedDisplay();
      }
    }

    if (localStorage.getItem(LS_DEBUG) === 'true') {
      this.debugMode = true;
      this.renderer.setDebugMode(true);
      this.elBtnDebug.style.color = '#00ff88';
    }
  }

  private saveSettings(): void {
    localStorage.setItem(LS_SPEED, this.engine.getSpeed().toString());
    localStorage.setItem(LS_DEBUG, this.debugMode.toString());
  }

  // --- Restart ---

  private doRestart(): void {
    this.selectedUnitId = null;
    this.renderer.setSelectedUnit(null);
    this.updateInfoPanel(null);
    this.renderer.clearTerrainCache();
    this.minimapRenderer.clearTerrainCache();
    this.engine.applyConfig(this.lastConfig);
    this.engine.restart();
    this.elBtnPause.textContent = 'Pause';
    this.updateSpeedDisplay();
  }

  // --- Info panel ---

  updateInfoPanel(unit: IUnit | null): void {
    if (!unit) {
      this.elUnitType.textContent = '—';
      this.elUnitHp.textContent = '—';
      this.elUnitCourage.textContent = '—';
      this.elUnitState.textContent = '—';
      return;
    }
    this.elUnitType.textContent = UnitType[unit.unitType];
    this.elUnitHp.textContent = `${Math.ceil(unit.hp)} / ${unit.maxHp}`;
    this.elUnitCourage.textContent = Math.round(unit.courage).toString();
    this.elUnitState.textContent =
      unit.state === BehaviorState.IDLE && unit.path.length > 0
        ? 'MOVING'
        : BehaviorState[unit.state];
  }

  private updateControlBar(): void {
    const bf = this.stateManager.getBattlefield();
    let warriors = 0;
    let berserkers = 0;
    for (const u of bf.units) {
      if (u.unitType === UnitType.WARRIOR) warriors++;
      else if (u.unitType === UnitType.BERSERKER) berserkers++;
    }
    this.elWaveCounter.textContent = `Wave: ${bf.waveNumber}`;
    this.elWarriorCount.textContent = `W: ${warriors}`;
    this.elBerserkerCount.textContent = `B: ${berserkers}`;
    this.elElapsedTime.textContent = `T: ${Math.floor(bf.elapsedTime)}s`;
  }

  private updateSpeedDisplay(): void {
    this.elSpeedDisplay.textContent = `${this.engine.getSpeed()}x`;
  }

  private startUIRefresh(): void {
    setInterval(() => {
      this.updateControlBar();
      if (this.selectedUnitId) {
        const unit = this.stateManager.getUnitById(this.selectedUnitId);
        this.updateInfoPanel(unit ?? null);
        if (!unit) this.selectedUnitId = null;
      }
    }, 100);
  }
}
