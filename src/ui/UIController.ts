import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { InputHandler } from './InputHandler';
import { IUnit, UnitType, BehaviorState } from '../types/types';

export class UIController {
  private engine: SimulationEngine;
  private stateManager: StateManager;
  private renderer: Renderer;
  private minimapRenderer: MinimapRenderer;
  private inputHandler: InputHandler;
  private selectedUnitId: string | null = null;

  private elBtnPause:     HTMLButtonElement;
  private elBtnFaster:    HTMLButtonElement;
  private elBtnSlower:    HTMLButtonElement;
  private elBtnRestart:   HTMLButtonElement;
  private elSpeedDisplay: HTMLElement;
  private elWaveCounter:  HTMLElement;
  private elUnitCount:    HTMLElement;
  private elUnitType:     HTMLElement;
  private elUnitHp:       HTMLElement;
  private elUnitCourage:  HTMLElement;
  private elUnitState:    HTMLElement;

  constructor(
    engine: SimulationEngine,
    stateManager: StateManager,
    renderer: Renderer,
    minimapRenderer: MinimapRenderer,
  ) {
    this.engine          = engine;
    this.stateManager    = stateManager;
    this.renderer        = renderer;
    this.minimapRenderer = minimapRenderer;
    this.inputHandler    = new InputHandler('battleCanvas');

    this.elBtnPause     = document.getElementById('btn-pause')     as HTMLButtonElement;
    this.elBtnFaster    = document.getElementById('btn-faster')    as HTMLButtonElement;
    this.elBtnSlower    = document.getElementById('btn-slower')    as HTMLButtonElement;
    this.elBtnRestart   = document.getElementById('btn-restart')   as HTMLButtonElement;
    this.elSpeedDisplay = document.getElementById('speed-display')!;
    this.elWaveCounter  = document.getElementById('wave-counter')!;
    this.elUnitCount    = document.getElementById('unit-count')!;
    this.elUnitType     = document.getElementById('unit-type')!;
    this.elUnitHp       = document.getElementById('unit-hp')!;
    this.elUnitCourage  = document.getElementById('unit-courage')!;
    this.elUnitState    = document.getElementById('unit-state')!;

    this.wireButtonEvents();
    this.wireInputEvents();
    this.startUIRefresh();
  }

  private wireButtonEvents(): void {
    this.elBtnPause.addEventListener('click', () => {
      this.engine.togglePause();
      this.elBtnPause.textContent = this.engine.isPaused() ? 'Resume' : 'Pause';
    });

    this.elBtnFaster.addEventListener('click', () => {
      this.engine.increaseSpeed();
      this.updateSpeedDisplay();
    });

    this.elBtnSlower.addEventListener('click', () => {
      this.engine.decreaseSpeed();
      this.updateSpeedDisplay();
    });

    this.elBtnRestart.addEventListener('click', () => this.doRestart());
  }

  private wireInputEvents(): void {
    this.inputHandler.onKeyDown((key: string) => {
      switch (key) {
        case ' ':
          this.engine.togglePause();
          this.elBtnPause.textContent = this.engine.isPaused() ? 'Resume' : 'Pause';
          break;
        case '+': case '=':
          this.engine.increaseSpeed();
          this.updateSpeedDisplay();
          break;
        case '-':
          this.engine.decreaseSpeed();
          this.updateSpeedDisplay();
          break;
        case 'r': case 'R':
          this.doRestart();
          break;
      }
    });

    // Scroll → zoom
    this.inputHandler.onScroll((delta, x, y) => {
      this.renderer.zoomAt(delta, x, y);
    });

    // Drag → pan
    this.inputHandler.onDrag((dx, dy) => {
      this.renderer.pan(dx, dy);
    });

    // Left click → select unit (uses camera-aware coordinate conversion)
    this.inputHandler.onLeftClick((cx, cy) => {
      const grid   = this.renderer.canvasToGrid(cx, cy);
      const nearby = this.stateManager.getUnitsInRadius(grid.x, grid.y, 2);
      const clicked = nearby[0] ?? null;
      this.selectedUnitId = clicked?.id ?? null;
      this.updateInfoPanel(clicked);
    });

    // Right click → hero task point
    this.inputHandler.onRightClick((cx, cy) => {
      const grid = this.renderer.canvasToGrid(cx, cy);
      const hero = this.stateManager.getHero();
      if (hero) hero.taskPoint = { x: grid.x, y: grid.y };
    });
  }

  private doRestart(): void {
    this.selectedUnitId = null;
    this.updateInfoPanel(null);
    this.renderer.clearTerrainCache();
    this.minimapRenderer.clearTerrainCache();
    this.engine.restart();
    this.elBtnPause.textContent = 'Pause';
    this.updateSpeedDisplay();
  }

  updateInfoPanel(unit: IUnit | null): void {
    if (!unit) {
      this.elUnitType.textContent    = '—';
      this.elUnitHp.textContent      = '—';
      this.elUnitCourage.textContent = '—';
      this.elUnitState.textContent   = '—';
      return;
    }
    this.elUnitType.textContent    = UnitType[unit.unitType];
    this.elUnitHp.textContent      = `${Math.ceil(unit.hp)} / ${unit.maxHp}`;
    this.elUnitCourage.textContent = Math.round(unit.courage).toString();
    this.elUnitState.textContent   = BehaviorState[unit.state];
  }

  private updateControlBar(): void {
    const bf = this.stateManager.getBattlefield();
    this.elWaveCounter.textContent = `Wave: ${bf.waveNumber}`;
    this.elUnitCount.textContent   = `Units: ${bf.units.length}`;
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
