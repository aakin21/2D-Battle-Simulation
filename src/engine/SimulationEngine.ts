import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { Pathfinder } from './Pathfinder';
import {
  IUnit,
  IHero,
  IBattlefield,
  UnitType,
  Faction,
  BehaviorState,
  TerrainType,
  TERRAIN_SPEED,
  UNIT_STATS,
  Position,
} from '../types/types';

const WARRIOR_ARRIVE_RADIUS = 2;
const COMBAT_RANGE = 2;
const ATTACK_INTERVAL = 1.0;
const FLEE_THRESHOLD = 25;
const FLEE_SPEED_MULT = 1.5;
const REST_TRIGGER_HP = 50;

export class SimulationEngine {
  private stateManager: StateManager;
  private renderer: Renderer;
  private minimapRenderer: MinimapRenderer;

  // Per-group patrol destination for berserkers — refreshed every 15–30 sim seconds
  private groupPatrol = new Map<string, { dest: Position; expiry: number }>();

  private paused: boolean = false;
  private speedMultiplier: number = 1;
  private lastTime: number = 0;
  private rafId: number = 0;

  constructor(stateManager: StateManager, renderer: Renderer, minimapRenderer: MinimapRenderer) {
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
    this.stateManager.setStressMode(false);
    this.stateManager.reset();
    this.groupPatrol.clear();
    this.paused = false;
    this.speedMultiplier = 1;
    this.start();
  }

  restartStressTest(): void {
    this.stop();
    this.stateManager.setStressMode(true);
    this.stateManager.reset();
    this.groupPatrol.clear();
    this.paused = false;
    this.speedMultiplier = 1;
    this.start();
  }

  private update(deltaTime: number): void {
    const { units, grid } = this.stateManager.getBattlefield();
    const hero = this.stateManager.getHero();

    for (const unit of units) {
      this.updateCourage(unit, units, hero);
    }

    for (const unit of units) {
      this.updateBehavior(unit, units);
    }

    for (const unit of units) {
      this.moveUnit(unit, deltaTime, hero, units, grid);
    }

    this.processRest(units, deltaTime);
    this.processCombat(units, deltaTime);
    this.removeDeadUnits();
    this.updateWaveSpawner(this.stateManager.getBattlefield());
  }

  private updateCourage(unit: IUnit, allUnits: IUnit[], hero: IHero | undefined): void {
    if (unit.unitType === UnitType.BERSERKER) return;
    if (unit.unitType === UnitType.HERO) return;

    const base = UNIT_STATS[UnitType[unit.unitType] as keyof typeof UNIT_STATS].courage;

    // Lose 10 courage for each 20% of max HP that is missing.
    const hpLostFraction = 1 - unit.hp / unit.maxHp;
    const woundedPenalty = -Math.floor(hpLostFraction / 0.2) * 10;

    const sight2 = unit.sight * unit.sight;
    let allies = 0;
    let enemies = 0;
    for (const other of allUnits) {
      if (other.hp <= 0) continue;
      const dx = other.position.x - unit.position.x;
      const dy = other.position.y - unit.position.y;
      if (dx * dx + dy * dy > sight2) continue;
      if (other.faction === unit.faction) allies++; // includes self
      else enemies++;
    }

    let ratioModifier = 0;
    const total = allies + enemies;
    if (total > 0) {
      const ratio = allies / total;
      if (ratio > 0.6) ratioModifier = 15;
      else if (ratio < 0.2) ratioModifier = -30;
      else if (ratio < 0.4) ratioModifier = -15;
      // 0.4–0.6: no change
    }

    let heroBonus = 0;
    if (unit.faction === Faction.FRIENDLY && hero && hero.hp > 0 && hero.id !== unit.id) {
      const dx = hero.position.x - unit.position.x;
      const dy = hero.position.y - unit.position.y;
      if (dx * dx + dy * dy <= hero.charismaRadius * hero.charismaRadius) {
        heroBonus = hero.charismaBonus;
      }
    }

    unit.courage = Math.max(0, Math.min(100, base + woundedPenalty + ratioModifier + heroBonus));
  }

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

  private updateBehavior(unit: IUnit, allUnits: IUnit[]): void {
    if (unit.unitType === UnitType.BERSERKER) {
      const enemy = this.findNearestEnemy(unit, allUnits);
      if (enemy) {
        const dx = enemy.position.x - unit.position.x;
        const dy = enemy.position.y - unit.position.y;
        if (dx * dx + dy * dy <= COMBAT_RANGE * COMBAT_RANGE) {
          unit.state = BehaviorState.ATTACK;
          unit.target = enemy.id;
          unit.path = [];
        } else {
          unit.state = BehaviorState.IDLE;
          unit.target = enemy.id;
          // path NOT cleared — moveUnit recalculates A* only when target moves to a new tile
        }
      } else {
        unit.state = BehaviorState.IDLE;
        unit.target = null;
        // path preserved — patrol destination stored in path[0]
      }
      return;
    }

    const enemy = this.findNearestEnemy(unit, allUnits);

    // --- FLEE state: courage recovered or no enemies → back to IDLE ---
    if (unit.state === BehaviorState.FLEE) {
      if (!enemy || unit.courage > FLEE_THRESHOLD) {
        unit.state = BehaviorState.IDLE;
        unit.target = null;
        unit.path = [];
      }
      return;
    }

    // --- REST state: enemy appeared or HP fully recovered → back to IDLE ---
    if (unit.state === BehaviorState.REST) {
      if (enemy || unit.hp >= unit.maxHp) {
        unit.state = BehaviorState.IDLE;
        unit.target = null;
      }
      return;
    }

    // --- FLEE entry: warriors only ---
    if (unit.unitType === UnitType.WARRIOR && enemy && unit.courage <= FLEE_THRESHOLD) {
      unit.state = BehaviorState.FLEE;
      unit.target = null;
      unit.path = [];
      return;
    }

    // --- REST entry: warriors and hero ---
    if ((unit.unitType === UnitType.WARRIOR || unit.unitType === UnitType.HERO) && unit.hp < REST_TRIGGER_HP && !enemy) {
      unit.state = BehaviorState.REST;
      unit.target = null;
      unit.path = [];
      return;
    }

    // --- Hero: only fights enemies already in combat range, never chases ---
    if (unit.unitType === UnitType.HERO) {
      if (enemy) {
        const dx = enemy.position.x - unit.position.x;
        const dy = enemy.position.y - unit.position.y;
        if (dx * dx + dy * dy <= COMBAT_RANGE * COMBAT_RANGE) {
          unit.state = BehaviorState.ATTACK;
          unit.target = enemy.id;
          unit.path = [];
          return;
        }
      }
      unit.state = BehaviorState.IDLE;
      unit.target = null;
      return;
    }

    // --- Warrior: IDLE / ATTACK ---
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
      unit.path = [];
    } else {
      unit.state = BehaviorState.IDLE;
      unit.target = enemy.id;
    }
  }

  private moveFlee(unit: IUnit, deltaTime: number, allUnits: IUnit[], grid: TerrainType[][]): void {
    const enemy = this.findNearestEnemy(unit, allUnits);
    if (!enemy) return;

    const dx = unit.position.x - enemy.position.x;
    const dy = unit.position.y - enemy.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;

    // Flee speed uses base speed, not current speed — HP penalty ignored.
    // A wounded warrior fleeing at 20% HP would otherwise be slower than a
    // full-health berserker and could never escape. Adrenaline negates the wound
    // penalty during flight.
    const xi = Math.floor(unit.position.x);
    const yi = Math.floor(unit.position.y);
    const terrain = grid[yi]?.[xi] ?? TerrainType.MOUNTAIN;
    const terrainMult = TERRAIN_SPEED[TerrainType[terrain]];
    const speed = unit.baseSpeed * terrainMult * FLEE_SPEED_MULT;
    const step = speed * deltaTime;
    const baseAngle = Math.atan2(dy, dx);

    // Try direct flee direction, then angular variations to get around mountains.
    // Uses isClearTile (tile + 4 neighbors non-mountain) so warriors don't flee into
    // tiles that A* considers blocked — berserkers would be unable to follow there.
    const offsets = [0, Math.PI / 8, -Math.PI / 8, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
    for (const offset of offsets) {
      const angle = baseAngle + offset;
      const newX = Math.max(0.5, Math.min(149.5, unit.position.x + Math.cos(angle) * step));
      const newY = Math.max(0.5, Math.min(149.5, unit.position.y + Math.sin(angle) * step));
      if (this.stateManager.isClearTile(Math.floor(newX), Math.floor(newY))) {
        unit.position.x = newX;
        unit.position.y = newY;
        return;
      }
    }
  }

  private updateWaveSpawner(bf: IBattlefield): void {
    const { elapsedTime, waveNumber } = bf;

    if (waveNumber < 3) {
      // Phase 1: fixed schedule — nextWaveTime starts at 30, then 90, then 180
      if (elapsedTime < bf.nextWaveTime) return;

      const sizes = [100, 150, 200];
      const nextTimes = [90, 180, 210];

      this.spawnBerserkerWave(sizes[waveNumber]);

      bf.nextWaveTime = nextTimes[waveNumber];
      bf.waveNumber++;
    } else {
      // Phase 2: sustained waves
      if (elapsedTime < bf.nextWaveTime) return;

      const size = 40 + Math.floor(Math.random() * 21); // 40–60
      this.spawnBerserkerWave(size);

      bf.nextWaveTime = elapsedTime + 20 + Math.random() * 20; // 20–40s until next
      bf.waveNumber++;
    }
  }

  private spawnBerserkerWave(count: number): void {
    const bf = this.stateManager.getBattlefield();
    const points = this.generateSpawnPoints(count);

    // Compute one shared A* path per spawn point — all berserkers from the same
    // point get a copy of it so they move as a group toward the same initial target.
    const sharedPaths: Position[][] = points.map((origin) => {
      const angle = Math.random() * Math.PI * 2;
      const d = 20 + Math.random() * 20; // 20–40 tiles into the map
      const px = Math.round(Math.max(5, Math.min(144, origin.x + Math.cos(angle) * d)));
      const py = Math.round(Math.max(5, Math.min(144, origin.y + Math.sin(angle) * d)));
      return Pathfinder.findPath(bf.grid, { x: origin.x, y: origin.y }, { x: px, y: py });
    });

    const waveNum = bf.waveNumber;

    for (let i = 0; i < count; i++) {
      const idx = i % points.length;
      const origin = points[idx];
      let x = Math.round(origin.x + (Math.random() * 6 - 3));
      let y = Math.round(origin.y + (Math.random() * 6 - 3));
      x = Math.max(1, Math.min(148, x));
      y = Math.max(1, Math.min(148, y));

      if (bf.grid[y]?.[x] === TerrainType.MOUNTAIN) {
        x = origin.x;
        y = origin.y;
      }

      const groupId = `w${waveNum}_p${idx}`;
      this.stateManager.spawnBerserker(x, y, groupId, sharedPaths[idx].slice());
    }
  }

  private generateSpawnPoints(count: number): Position[] {
    const bf = this.stateManager.getBattlefield();
    const numPoints = Math.max(1, Math.min(8, Math.ceil(count / 20)));
    const points: Position[] = [];
    let attempts = 0;

    while (points.length < numPoints && attempts < 200) {
      attempts++;

      // Choose a random edge and an inset of 5–25 tiles from that border
      const edge = Math.floor(Math.random() * 4); // 0=top 1=bottom 2=left 3=right
      const inset = 5 + Math.floor(Math.random() * 21);
      let x: number;
      let y: number;

      if (edge === 0) {
        x = 5 + Math.floor(Math.random() * 140);
        y = inset;
      } else if (edge === 1) {
        x = 5 + Math.floor(Math.random() * 140);
        y = 149 - inset;
      } else if (edge === 2) {
        x = inset;
        y = 5 + Math.floor(Math.random() * 140);
      } else {
        x = 149 - inset;
        y = 5 + Math.floor(Math.random() * 140);
      }

      // Minimum 20-tile separation between spawn points
      const tooClose = points.some((p) => {
        const dx = p.x - x;
        const dy = p.y - y;
        return dx * dx + dy * dy < 20 * 20;
      });

      if (!tooClose && this.stateManager.isClearTile(x, y)) {
        points.push({ x, y });
      }
    }

    if (points.length === 0) points.push({ x: 5, y: 5 });
    return points;
  }

  private getGroupPatrolDest(groupId: string, pos: Position, elapsed: number): Position {
    const entry = this.groupPatrol.get(groupId);
    if (entry && elapsed < entry.expiry) return entry.dest;

    // Destination expired or not set — pick a new one for the whole group
    const angle = Math.random() * Math.PI * 2;
    const d = 20 + Math.random() * 30; // 20–50 tiles
    const dest: Position = {
      x: Math.round(Math.max(5, Math.min(144, pos.x + Math.cos(angle) * d))),
      y: Math.round(Math.max(5, Math.min(144, pos.y + Math.sin(angle) * d))),
    };
    this.groupPatrol.set(groupId, { dest, expiry: elapsed + 15 + Math.random() * 15 });
    return dest;
  }

  private processRest(units: IUnit[], deltaTime: number): void {
    for (const unit of units) {
      if (unit.state !== BehaviorState.REST) continue;
      unit.hp = Math.min(unit.maxHp, unit.hp + 10 * deltaTime);
    }
  }

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

    // apply simultaneously
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
    grid: TerrainType[][]
  ): void {
    if (unit.state === BehaviorState.FLEE) {
      this.moveFlee(unit, deltaTime, allUnits, grid);
      return;
    }

    if (unit.unitType === UnitType.BERSERKER) {
      if (unit.state !== BehaviorState.IDLE) return;

      if (unit.target !== null) {
        // Chase: A* to visible enemy, recalculate when enemy moves to a new tile
        const target = this.stateManager.getUnitById(unit.target);
        if (target && target.hp > 0) {
          const dtx = Math.floor(target.position.x);
          const dty = Math.floor(target.position.y);
          const pe = unit.path.length > 0 ? unit.path[unit.path.length - 1] : null;
          if (!pe || pe.x !== dtx || pe.y !== dty) {
            const st = { x: Math.floor(unit.position.x), y: Math.floor(unit.position.y) };
            unit.path = Pathfinder.findPath(grid, st, { x: dtx, y: dty });
          }
        } else {
          unit.target = null;
          unit.path = [];
        }
      } else if (unit.path.length === 0) {
        // No target, no path — use group patrol destination so the whole group
        // moves together rather than each berserker picking a random direction.
        const elapsed = this.stateManager.getBattlefield().elapsedTime;
        const dest = this.getGroupPatrolDest(unit.groupId, unit.position, elapsed);
        const dtx = Math.floor(dest.x);
        const dty = Math.floor(dest.y);
        if (Math.floor(unit.position.x) !== dtx || Math.floor(unit.position.y) !== dty) {
          const st = { x: Math.floor(unit.position.x), y: Math.floor(unit.position.y) };
          unit.path = Pathfinder.findPath(grid, st, { x: dtx, y: dty });
          // If A* can't reach the cached destination, force a new one next tick
          if (unit.path.length === 0) this.groupPatrol.delete(unit.groupId);
        }
      }

      if (unit.path.length === 0) return;

      const bWp = unit.path[0];
      const bWpx = bWp.x + 0.5;
      const bWpy = bWp.y + 0.5;
      const bSpeed = this.computeSpeed(unit, grid);
      if (bSpeed === 0) return;

      const bDx = bWpx - unit.position.x;
      const bDy = bWpy - unit.position.y;
      const bDist = Math.sqrt(bDx * bDx + bDy * bDy);
      const bStep = bSpeed * deltaTime;

      if (bDist <= bStep) {
        unit.position.x = bWpx;
        unit.position.y = bWpy;
        unit.path.shift();
      } else {
        unit.position.x += (bDx / bDist) * bStep;
        unit.position.y += (bDy / bDist) * bStep;
      }
      return;
    }

    if (unit.state !== BehaviorState.IDLE) return;

    const dest = this.getDestination(unit, hero);
    if (!dest) {
      unit.path = [];
      return;
    }

    // stop near hero when not in combat and hero is stationary
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

    const waypoint = unit.path[0];
    const wpx = waypoint.x + 0.5;
    const wpy = waypoint.y + 0.5;

    const speed = this.computeSpeed(unit, grid);
    if (speed === 0) return;

    const dx = wpx - unit.position.x;
    const dy = wpy - unit.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = speed * deltaTime;

    if (dist <= step) {
      unit.position.x = wpx;
      unit.position.y = wpy;
      unit.path.shift();
    } else {
      unit.position.x += (dx / dist) * step;
      unit.position.y += (dy / dist) * step;
    }
  }

  private getDestination(unit: IUnit, hero: IHero | undefined): Position | null {
    // chase enemy if in sight
    if (unit.target !== null) {
      const target = this.stateManager.getUnitById(unit.target);
      if (target && target.hp > 0) return target.position;
    }

    if (unit.unitType === UnitType.HERO) {
      return (unit as IHero).taskPoint ?? null;
    }
    if (unit.unitType === UnitType.WARRIOR) {
      if (!hero || !hero.taskPoint) return null;
      // only warriors within hero's sight range follow the task point
      const dx = hero.position.x - unit.position.x;
      const dy = hero.position.y - unit.position.y;
      if (dx * dx + dy * dy > hero.sight * hero.sight) return null;
      return hero.taskPoint;
    }
    return null;
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

    // cap delta to avoid jumps when tab was inactive
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
