import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { InputHandler } from './InputHandler';
import { Hud } from './Hud';
import { Sound } from './Sound';
import { IUnit, IHero, UnitType, Faction, BehaviorState, GRID_SIZE } from '../types/types';

// The mouse on the battlefield: selecting a unit (left click), ordering a hero (right click),
// the tooltip, zoom and pan, the area-count rectangle and the minimap click. Keeps which unit
// is selected.
export class CanvasInteraction {
  private selectedUnitId: string | null = null;

  // Throttle tooltip updates — only recalculate when cursor moves significantly
  private lastTooltipX: number = -999;
  private lastTooltipY: number = -999;

  private elTooltip = document.getElementById('tooltip')!;
  private elSelectOverlay = document.getElementById('select-overlay')!;

  constructor(
    private engine: SimulationEngine,
    private stateManager: StateManager,
    private renderer: Renderer,
    private hud: Hud,
    private sound: Sound,
    private inputHandler: InputHandler
  ) {}

  // Registers the mouse callbacks (the keyboard is UIController's).
  wire(): void {
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

    // Left click → clear task point + select the nearest unit
    this.inputHandler.onLeftClick((cx, cy) => {
      const hero = this.stateManager.getHero();
      if (hero && !this.engine.isBattleMode()) this.engine.issueCommand(hero, null, 'user');
      const grid = this.renderer.canvasToGrid(cx, cy);
      const clicked = this.nearestUnit(grid.x, grid.y, 2);
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

  clearSelection(): void {
    this.selectedUnitId = null;
    this.renderer.setSelectedUnit(null);
    this.hud.showUnit(null);
  }

  // Refreshes the selected unit's card; a unit that is gone is no longer selected.
  refreshSelection(): void {
    if (!this.selectedUnitId) return;
    const unit = this.stateManager.getUnitById(this.selectedUnitId);
    this.hud.showUnit(unit ?? null);
    if (!unit) {
      this.selectedUnitId = null;
      this.renderer.setSelectedUnit(null);
    }
  }

  // The unit within `radius` tiles closest to a grid point; on a tie, the first one found.
  private nearestUnit(x: number, y: number, radius: number): IUnit | null {
    let closest: IUnit | null = null;
    let minD2 = Infinity;
    for (const u of this.stateManager.getUnitsInRadius(x, y, radius)) {
      const dx = u.position.x - x;
      const dy = u.position.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) {
        minD2 = d2;
        closest = u;
      }
    }
    return closest;
  }

  // --- Tooltip ---

  private updateTooltip(cx: number, cy: number): void {
    const grid = this.renderer.canvasToGrid(cx, cy);
    const closest = this.nearestUnit(grid.x, grid.y, 1.5);

    if (!closest) {
      this.elTooltip.style.display = 'none';
      return;
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
}
