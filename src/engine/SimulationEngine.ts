import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { Pathfinder } from './Pathfinder';
import { IUnit, IHero, UnitType, BehaviorState, TerrainType, TERRAIN_SPEED, Position } from '../types/types';

// Warriors stop when within this many tiles of the hero
const WARRIOR_ARRIVE_RADIUS = 2;
// A waypoint is blocked if a moving unit is within this many tiles of its center
const COLLISION_RADIUS = 0.6;
// Units enter ATTACK state when an enemy is within this many tiles
const COMBAT_RANGE = 2;
// Seconds between attacks
const ATTACK_INTERVAL = 1.0;

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

    // 1. Determine behavior states (target selection, IDLE ↔ ATTACK transitions)
    for (const unit of units) {
      this.updateBehavior(unit, units);
    }

    // 2. Move IDLE units
    for (const unit of units) {
      this.moveUnit(unit, deltaTime, hero, units, grid);
    }

    // 3. Process combat — damage is accumulated then applied simultaneously
    this.processCombat(units, deltaTime);

    // 4. Remove units with HP ≤ 0
    this.removeDeadUnits();

    // Week 4+: courage calculation
    // Week 5+: flee and rest behavior
    // Week 6+: hero control and charisma
    // Week 7+: wave spawning
  }

  // Returns the nearest enemy within sight range, or null if none.
  private findNearestEnemy(unit: IUnit, allUnits: IUnit[]): IUnit | null {
    const sight2 = unit.sight * unit.sight;
    let nearest: IUnit | null = null;
    let minDist2 = Infinity;

    for (const other of allUnits) {
      if (other.faction === unit.faction || other.hp <= 0) continue;
      const dx = other.position.x - unit.position.x;
      const dy = other.position.y - unit.position.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= sight2 && d2 < minDist2) {
        minDist2 = d2;
        nearest = other;
      }
    }
    return nearest;
  }

  // Sets unit.state and unit.target based on enemy proximity.
  // ATTACK: enemy within COMBAT_RANGE — unit stops and fights.
  // IDLE (with target): enemy in sight but not yet in range — unit approaches.
  // IDLE (no target): no enemy in sight — unit follows hero/taskPoint as before.
  private updateBehavior(unit: IUnit, allUnits: IUnit[]): void {
    // BERSERKER targeting handled in Week 7
    if (unit.unitType === UnitType.BERSERKER) return;
    // FLEE and REST states managed in Week 5
    if (unit.state === BehaviorState.FLEE || unit.state === BehaviorState.REST) return;

    const enemy = this.findNearestEnemy(unit, allUnits);

    if (!enemy) {
      unit.state = BehaviorState.IDLE;
      unit.target = null;
      return;
    }

    const dx = enemy.position.x - unit.position.x;
    const dy = enemy.position.y - unit.position.y;
    const dist2 = dx * dx + dy * dy;

    if (dist2 <= COMBAT_RANGE * COMBAT_RANGE) {
      unit.state = BehaviorState.ATTACK;
      unit.target = enemy.id;
      unit.path = [];  // stop pathing when entering melee range
    } else {
      // Enemy visible but outside attack range — approach
      unit.state = BehaviorState.IDLE;
      unit.target = enemy.id;
    }
  }

  // Accumulates damage for all ATTACK units and applies it simultaneously.
  private processCombat(units: IUnit[], deltaTime: number): void {
    const pendingDamage = new Map<string, number>();

    for (const unit of units) {
      if (unit.state !== BehaviorState.ATTACK || unit.target === null) continue;

      unit.attackCooldown -= deltaTime;
      if (unit.attackCooldown > 0) continue;

      const target = this.stateManager.getUnitById(unit.target);
      if (!target || target.hp <= 0) {
        unit.target = null;
        unit.state = BehaviorState.IDLE;
        continue;
      }

      pendingDamage.set(target.id, (pendingDamage.get(target.id) ?? 0) + unit.damage);
      unit.attackCooldown = ATTACK_INTERVAL;
    }

    // Apply all damage at once so both sides of a fight take damage in the same tick
    for (const [id, damage] of pendingDamage) {
      const target = this.stateManager.getUnitById(id);
      if (target) target.hp = Math.max(0, target.hp - damage);
    }
  }

  private removeDeadUnits(): void {
    const dead: string[] = [];
    for (const unit of this.stateManager.getBattlefield().units) {
      if (unit.hp <= 0) dead.push(unit.id);
    }
    for (const id of dead) {
      this.stateManager.removeUnit(id);
    }
  }

  private moveUnit(
    unit: IUnit,
    deltaTime: number,
    hero: IHero | undefined,
    allUnits: IUnit[],
    grid: TerrainType[][],
  ): void {
    // Only IDLE units move — ATTACK/FLEE/REST handled separately
    if (unit.state !== BehaviorState.IDLE) return;
    // Berserker movement in Week 7
    if (unit.unitType === UnitType.BERSERKER) return;

    const dest = this.getDestination(unit, hero);
    if (!dest) {
      unit.path = [];
      return;
    }

    // Warriors stop when close enough to the hero — only when not chasing an enemy
    // and only when hero is stationary
    if (
      unit.unitType === UnitType.WARRIOR &&
      unit.target === null &&
      hero &&
      hero.path.length === 0
    ) {
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

    // Basic collision: don't enter a waypoint occupied by another moving unit
    const blocked = allUnits.some(
      u =>
        u.id !== unit.id &&
        u.path.length > 0 &&
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
    // Enemy in sight range — approach them (takes priority over hero/taskPoint)
    if (unit.target !== null) {
      const target = this.stateManager.getUnitById(unit.target);
      if (target && target.hp > 0) return target.position;
    }

    if (unit.unitType === UnitType.HERO) {
      return (unit as IHero).taskPoint ?? null;
    }
    if (unit.unitType === UnitType.WARRIOR) {
      if (!hero) return null;
      // Only warriors within the hero's sight range (15 tiles) get the task point.
      const dx = hero.position.x - unit.position.x;
      const dy = hero.position.y - unit.position.y;
      if (dx * dx + dy * dy > hero.sight * hero.sight) return null;
      return hero.taskPoint ?? hero.position;
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
