import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { Pathfinder } from './Pathfinder';
import { IUnit, IHero, UnitType, BehaviorState, TerrainType, TERRAIN_SPEED, Position } from '../types/types';

// Warriors stop when within this many tiles of the hero
const WARRIOR_ARRIVE_RADIUS = 2;
// A waypoint is considered occupied if another unit is within this many tiles of its center
const COLLISION_RADIUS = 0.6;

export class SimulationEngine {
  private stateManager: StateManager;
  private renderer: Renderer;
  private minimapRenderer: MinimapRenderer;

  private paused: boolean = false;
  private speedMultiplier: number = 1;
  private lastTime: number = 0;
  private rafId: number = 0;

  constructor(
    stateManager: StateManager,
    renderer: Renderer,
    minimapRenderer: MinimapRenderer
  ) {
    this.stateManager = stateManager;
    this.renderer = renderer;
    this.minimapRenderer = minimapRenderer;
  }

  start(): void {
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.loop.bind(this));
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setSpeed(multiplier: 0.5 | 1 | 2 | 4): void {
    this.speedMultiplier = multiplier;
  }

  getSpeed(): number {
    return this.speedMultiplier;
  }

  // Cycle through speed values: 0.5 → 1 → 2 → 4 → 0.5
  increaseSpeed(): void {
    const steps: Array<0.5 | 1 | 2 | 4> = [0.5, 1, 2, 4];
    const idx = steps.indexOf(this.speedMultiplier as 0.5 | 1 | 2 | 4);
    if (idx < steps.length - 1) this.speedMultiplier = steps[idx + 1];
  }

  decreaseSpeed(): void {
    const steps: Array<0.5 | 1 | 2 | 4> = [0.5, 1, 2, 4];
    const idx = steps.indexOf(this.speedMultiplier as 0.5 | 1 | 2 | 4);
    if (idx > 0) this.speedMultiplier = steps[idx - 1];
  }

  restart(): void {
    this.stop();
    this.stateManager.reset();
    this.paused = false;
    this.speedMultiplier = 1;
    this.start();
  }

  private update(deltaTime: number): void {
    const { units, grid } = this.stateManager.getBattlefield();
    const hero = this.stateManager.getHero();

    for (const unit of units) {
      this.moveUnit(unit, deltaTime, hero, units, grid);
    }
    // Week 3+: combat
    // Week 4+: courage calculation
    // Week 5+: flee and rest behavior
    // Week 6+: hero control and charisma
    // Week 7+: wave spawning
  }

  private moveUnit(
    unit: IUnit,
    deltaTime: number,
    hero: IHero | undefined,
    allUnits: IUnit[],
    grid: TerrainType[][],
  ): void {
    // Only IDLE units move — ATTACK/FLEE/REST handled in later weeks
    if (unit.state !== BehaviorState.IDLE) return;
    // Berserker movement in Week 7
    if (unit.unitType === UnitType.BERSERKER) return;

    const dest = this.getDestination(unit, hero);
    if (!dest) {
      unit.path = [];
      return;
    }

    // Warriors stop when close enough to the hero's current position
    if (unit.unitType === UnitType.WARRIOR && hero) {
      const dx = hero.position.x - unit.position.x;
      const dy = hero.position.y - unit.position.y;
      if (dx * dx + dy * dy <= WARRIOR_ARRIVE_RADIUS * WARRIOR_ARRIVE_RADIUS) {
        unit.path = [];
        return;
      }
    }

    // Recalculate path only when the destination tile changes
    const destTileX = Math.floor(dest.x);
    const destTileY = Math.floor(dest.y);
    const pathEnd = unit.path.length > 0 ? unit.path[unit.path.length - 1] : null;

    const needsRepath = !pathEnd || pathEnd.x !== destTileX || pathEnd.y !== destTileY;

    if (needsRepath) {
      const startTile: Position = {
        x: Math.floor(unit.position.x),
        y: Math.floor(unit.position.y),
      };
      unit.path = Pathfinder.findPath(grid, startTile, { x: destTileX, y: destTileY });
    }

    if (unit.path.length === 0) return;

    // Move toward center of next waypoint tile
    const waypoint = unit.path[0];
    const wpx = waypoint.x + 0.5;
    const wpy = waypoint.y + 0.5;

    // Basic collision: don't enter a waypoint already occupied by another unit
    const blocked = allUnits.some(
      u =>
        u.id !== unit.id &&
        Math.abs(u.position.x - wpx) < COLLISION_RADIUS &&
        Math.abs(u.position.y - wpy) < COLLISION_RADIUS,
    );
    if (blocked) return;

    const speed = this.computeSpeed(unit, grid);
    if (speed === 0) return;

    const dx = wpx - unit.position.x;
    const dy = wpy - unit.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = speed * deltaTime;

    if (dist <= step) {
      // Snap to waypoint center and advance path
      unit.position.x = wpx;
      unit.position.y = wpy;
      unit.path.shift();
    } else {
      unit.position.x += (dx / dist) * step;
      unit.position.y += (dy / dist) * step;
    }
  }

  private getDestination(unit: IUnit, hero: IHero | undefined): Position | null {
    if (unit.unitType === UnitType.HERO) {
      return (unit as IHero).taskPoint ?? null;
    }
    if (unit.unitType === UnitType.WARRIOR) {
      if (!hero || !hero.taskPoint) return null;
      // Only warriors within the hero's sight range (15 tiles) get the task point.
      const dx = hero.position.x - unit.position.x;
      const dy = hero.position.y - unit.position.y;
      if (dx * dx + dy * dy > hero.sight * hero.sight) return null;
      return hero.taskPoint;
    }
    return null; // BERSERKER — Week 7
  }

  private computeSpeed(unit: IUnit, grid: TerrainType[][]): number {
    const xi = Math.floor(unit.position.x);
    const yi = Math.floor(unit.position.y);
    const terrain = grid[yi]?.[xi] ?? TerrainType.MOUNTAIN;
    const terrainMult = TERRAIN_SPEED[TerrainType[terrain]];
    const hpMult = 0.5 + 0.5 * (unit.hp / unit.maxHp);
    return unit.baseSpeed * hpMult * terrainMult;
  }

  private loop(timestamp: number): void {
    const rawDelta = (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;

    // Cap delta to avoid large jumps when tab was inactive
    const deltaTime = Math.min(rawDelta, 0.1) * this.speedMultiplier;

    if (!this.paused) {
      this.update(deltaTime);
      this.stateManager.getBattlefield().elapsedTime += deltaTime;
    }

    const battlefield = this.stateManager.getBattlefield();
    this.renderer.render(battlefield);
    this.minimapRenderer.render(battlefield, this.renderer.getCamera());

    this.rafId = requestAnimationFrame(this.loop.bind(this));
  }
}
