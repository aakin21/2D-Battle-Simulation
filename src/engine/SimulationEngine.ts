import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { Pathfinder } from './Pathfinder';
import { HeroCommands } from './HeroCommands';
import {
  COMBAT_RANGE,
  ATTACK_INTERVAL,
  FLEE_THRESHOLD,
  WOUND_STEP,
  WOUND_PENALTY,
  ALLY_SHARE_HIGH,
  ALLY_SHARE_HIGH_BONUS,
  ALLY_SHARE_LOW,
  ALLY_SHARE_LOW_PENALTY,
  ALLY_SHARE_VERY_LOW,
  ALLY_SHARE_VERY_LOW_PENALTY,
  REST_TRIGGER_HP,
  REST_HEAL_PER_SEC,
  DISENGAGE_CLEAR_RADIUS,
} from './Rules';
import { GroupPatrol } from './GroupPatrol';
import { updateRuleHeroes } from './RuleHeroes';
import { updateControl, damageBases, objectiveEnd, EndReason } from './Objectives';
import { updateHeroReflex, moveHeroRetreat } from './HeroReflex';
import {
  effectiveSight,
  findNearestEnemy,
  findNearestEnemyAnywhere,
  stepToward,
  terrainSpeed,
} from './UnitHelpers';
import {
  IUnit,
  IHero,
  IBattlefield,
  UnitType,
  Faction,
  BehaviorState,
  TerrainType,
  UNIT_STATS,
  Position,
  HeroCommand,
  CommandSource,
  AITiming,
  SimConfig,
  DEFAULT_CONFIG,
} from '../types/types';

const WARRIOR_ARRIVE_RADIUS = 2;

// An AI layer that gives heroes orders (Jev or the LLM). Ticked every simulation step.
export interface AIController {
  tick(elapsed: number): void;
  isWaiting(): boolean; // a request is open and its answer has not arrived yet
}

// Battle mode result: the side whose units (heroes and soldiers) all die first loses.
export interface MatchResult {
  winner: Faction | null; // null: draw
  time: number; // simulation seconds
  survivors: number; // units left on the winning side
  reason: EndReason; // how the match was decided (D30)
  scores?: { friendly: number; enemy: number }; // control mode
}

export class SimulationEngine {
  private stateManager: StateManager;
  private renderer: Renderer;
  private minimapRenderer: MinimapRenderer;

  private patrol = new GroupPatrol();
  private commands: HeroCommands;

  // Reused buffer for courage counts: [friendly, enemy]
  private factionCounts = new Int32Array(2);
  private paused: boolean = false;
  private stressMode: boolean = false;
  private battleMode: boolean = false;
  private controllers: AIController[] = [];
  private result: MatchResult | null = null;
  private aiTiming: AITiming = 'realtime';
  private onMatchEnd: ((result: MatchResult) => void) | null = null;
  private speedMultiplier: number = 1;
  private waveMultiplier: number = 1;
  private lastConfig: SimConfig = DEFAULT_CONFIG;
  private lastTime: number = 0;
  private rafId: number = 0;

  constructor(stateManager: StateManager, renderer: Renderer, minimapRenderer: MinimapRenderer) {
    this.stateManager = stateManager;
    this.renderer = renderer;
    this.minimapRenderer = minimapRenderer;
    this.commands = new HeroCommands(stateManager);
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

  applyConfig(config: SimConfig): void {
    this.lastConfig = config;
    this.waveMultiplier = config.waveMultiplier;
    this.aiTiming = config.aiTiming ?? 'realtime';
  }

  // D4 paused mode: the simulation does not advance while an AI answer is pending.
  isWaitingForAI(): boolean {
    return this.aiTiming === 'paused' && this.controllers.some((c) => c.isWaiting());
  }

  isBattleMode(): boolean {
    return this.battleMode;
  }

  isStressMode(): boolean {
    return this.stressMode;
  }

  getResult(): MatchResult | null {
    return this.result;
  }

  setOnMatchEnd(cb: (result: MatchResult) => void): void {
    this.onMatchEnd = cb;
  }

  // AI controllers for the current match; cleared on every restart.
  setControllers(controllers: AIController[]): void {
    this.controllers = controllers;
  }

  // Single entry point for hero orders (D20): user clicks, rule heroes, Jev and the LLM
  // all come through here, so a hero behaves the same whoever gave the order.
  issueCommand(hero: IHero, command: HeroCommand | null, source: CommandSource): void {
    this.commands.issue(hero, command, source, this.battleMode);
  }

  restart(): void {
    this.stop();
    this.stressMode = false;
    this.stateManager.setStressMode(false);
    this.stateManager.reset(this.lastConfig);
    this.controllers = [];
    this.result = null;
    this.battleMode = this.stateManager.isBattleMode();
    this.renderer.setBattleMode(this.battleMode);
    this.patrol.clear();
    this.paused = false;
    this.speedMultiplier = 1;
    this.start();
  }

  restartStressTest(): void {
    this.stop();
    this.stressMode = true;
    this.stateManager.setStressMode(true);
    this.stateManager.reset();
    this.controllers = [];
    this.result = null;
    this.battleMode = false;
    this.renderer.setBattleMode(false);
    this.patrol.clear();
    this.paused = false;
    this.speedMultiplier = 1;
    this.start();
  }

  private update(deltaTime: number): void {
    const { units, grid, elapsedTime } = this.stateManager.getBattlefield();

    for (const controller of this.controllers) controller.tick(elapsedTime);
    if (this.battleMode) updateRuleHeroes(this.stateManager, this.commands, this.patrol);
    this.commands.applyAll();

    for (const unit of units) {
      this.updateCourage(unit);
    }

    for (const unit of units) {
      this.updateBehavior(unit);
    }

    // Save position before move so spatial grid can be synced after.
    for (const unit of units) {
      const oldX = unit.position.x;
      const oldY = unit.position.y;
      this.moveUnit(unit, deltaTime, grid);
      this.stateManager.syncPosition(unit, oldX, oldY);
    }

    this.processRest(units, deltaTime);
    this.processCombat(units, deltaTime);
    if (this.battleMode) {
      const mode = this.stateManager.getBattlefield().objective.mode;
      if (mode === 'control') updateControl(this.stateManager, deltaTime);
      if (mode === 'base') damageBases(this.stateManager, units, deltaTime);
    }
    this.removeDeadUnits();
    if (this.battleMode) this.checkMatchEnd();
    this.updateWaveSpawner(this.stateManager.getBattlefield());
  }

  // Soldiers follow heroes and use courage. In battle mode berserkers are soldiers too.
  private isSoldier(unit: IUnit): boolean {
    return (
      unit.unitType === UnitType.WARRIOR ||
      (this.battleMode && unit.unitType === UnitType.BERSERKER)
    );
  }

  // Nearest living hero of the unit's own side within maxDist (or within the hero's
  // sight when maxDist is not given). In classic mode this is the single hero.
  private findLeader(unit: IUnit, maxDist?: (hero: IHero) => number): IHero | undefined {
    let best: IHero | undefined;
    let bestD2 = Infinity;
    for (const hero of this.stateManager.getHeroes()) {
      if (hero.faction !== unit.faction || hero.hp <= 0 || hero.id === unit.id) continue;
      const dx = hero.position.x - unit.position.x;
      const dy = hero.position.y - unit.position.y;
      const d2 = dx * dx + dy * dy;
      const r = maxDist ? maxDist(hero) : hero.sight;
      if (d2 <= r * r && d2 < bestD2) {
        bestD2 = d2;
        best = hero;
      }
    }
    return best;
  }

  // Ends the match when one side has no units left, then freezes the simulation.
  private checkMatchEnd(): void {
    if (this.result) return;
    let friendly = 0;
    let enemy = 0;
    for (const u of this.stateManager.getBattlefield().units) {
      if (u.faction === Faction.FRIENDLY) friendly++;
      else enemy++;
    }
    const bf = this.stateManager.getBattlefield();
    let winner: Faction | null;
    let reason: EndReason;
    if (friendly === 0 || enemy === 0) {
      winner = friendly > 0 ? Faction.FRIENDLY : enemy > 0 ? Faction.ENEMY : null;
      reason = 'elimination';
    } else {
      const end = objectiveEnd(this.stateManager);
      if (!end) return;
      ({ winner, reason } = end);
    }

    this.result = {
      winner,
      time: bf.elapsedTime,
      survivors: winner === Faction.FRIENDLY ? friendly : winner === Faction.ENEMY ? enemy : 0,
      reason,
      ...(bf.objective.mode === 'control'
        ? {
            scores: {
              friendly: Math.round(bf.objective.scores.friendly),
              enemy: Math.round(bf.objective.scores.enemy),
            },
          }
        : {}),
    };
    this.paused = true;
    this.onMatchEnd?.(this.result);
  }

  private enemyWithin(unit: IUnit, radius: number): boolean {
    let found = false;
    this.stateManager.forEachInRadius(unit.position.x, unit.position.y, radius, (other) => {
      if (!found && other.hp > 0 && other.faction !== unit.faction) found = true;
    });
    return found;
  }

  private updateCourage(unit: IUnit): void {
    if (!this.isSoldier(unit)) return;

    // Battle mode: both sides use warrior stats (D19), courage included.
    const base = this.battleMode
      ? UNIT_STATS.WARRIOR.courage
      : UNIT_STATS[UnitType[unit.unitType] as keyof typeof UNIT_STATS].courage;

    const hpLostFraction = 1 - unit.hp / unit.maxHp;
    const woundedPenalty = -Math.floor(hpLostFraction / WOUND_STEP) * WOUND_PENALTY;

    // Living units in sight per faction, the unit itself included (D31: same counts as a
    // full scan, computed from per-cell counters)
    const sight = effectiveSight(this.stateManager, unit);
    const counts = this.factionCounts;
    this.stateManager.countByFactionInRadius(unit.position.x, unit.position.y, sight, counts);
    const allies = counts[unit.faction];
    const enemies = counts[0] + counts[1] - allies;

    let ratioModifier = 0;
    const total = allies + enemies;
    if (total > 0) {
      const ratio = allies / total;
      if (ratio > ALLY_SHARE_HIGH) ratioModifier = ALLY_SHARE_HIGH_BONUS;
      else if (ratio < ALLY_SHARE_VERY_LOW) ratioModifier = -ALLY_SHARE_VERY_LOW_PENALTY;
      else if (ratio < ALLY_SHARE_LOW) ratioModifier = -ALLY_SHARE_LOW_PENALTY;
    }

    const charismaHero = this.findLeader(unit, (h) => h.charismaRadius);
    const heroBonus = charismaHero ? charismaHero.charismaBonus : 0;

    unit.courage = Math.max(0, Math.min(100, base + woundedPenalty + ratioModifier + heroBonus));
  }

  private updateBehavior(unit: IUnit): void {
    if (
      this.battleMode &&
      unit.unitType === UnitType.HERO &&
      updateHeroReflex(this.stateManager, unit as IHero)
    )
      return;

    if (unit.unitType === UnitType.BERSERKER && !this.battleMode) {
      const enemy = findNearestEnemy(this.stateManager, unit);
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
        }
      } else {
        unit.state = BehaviorState.IDLE;
        unit.target = null;
      }
      return;
    }

    const enemy = findNearestEnemy(this.stateManager, unit);

    if (unit.state === BehaviorState.FLEE) {
      if (!enemy || unit.courage > FLEE_THRESHOLD) {
        unit.state = BehaviorState.IDLE;
        unit.target = null;
        unit.path = [];
      }
      return;
    }

    if (unit.state === BehaviorState.REST) {
      if (enemy || unit.hp >= unit.maxHp) {
        unit.state = BehaviorState.IDLE;
        unit.target = null;
      }
      return;
    }

    if (this.isSoldier(unit) && enemy && unit.courage <= FLEE_THRESHOLD) {
      unit.state = BehaviorState.FLEE;
      unit.target = null;
      unit.path = [];
      return;
    }

    if (
      (this.isSoldier(unit) || unit.unitType === UnitType.HERO) &&
      unit.hp < REST_TRIGGER_HP &&
      !enemy
    ) {
      unit.state = BehaviorState.REST;
      unit.target = null;
      unit.path = [];
      return;
    }

    if (unit.unitType === UnitType.HERO) {
      // D27: a hero breaking off a fight walks on without engaging until it is clear of
      // enemies, then behaves normally again (so it does not march into the next group).
      const hero = unit as IHero;
      if (hero.disengaging) {
        if (this.enemyWithin(hero, DISENGAGE_CLEAR_RADIUS)) {
          hero.state = BehaviorState.IDLE;
          hero.target = null;
          return;
        }
        hero.disengaging = false;
      }
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

  private moveFlee(unit: IUnit, deltaTime: number, grid: TerrainType[][]): void {
    const enemy = findNearestEnemy(this.stateManager, unit);
    if (!enemy) return;

    const dx = unit.position.x - enemy.position.x;
    const dy = unit.position.y - enemy.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return;

    stepToward(this.stateManager, unit, Math.atan2(dy, dx), deltaTime, grid);
  }

  private updateWaveSpawner(bf: IBattlefield): void {
    if (this.stressMode) return;
    const { elapsedTime, waveNumber } = bf;

    if (waveNumber < 3) {
      if (elapsedTime < bf.nextWaveTime) return;

      const sizes = [100, 150, 200];
      const nextTimes = [90, 180, 210];

      this.spawnBerserkerWave(Math.round(sizes[waveNumber] * this.waveMultiplier));

      bf.nextWaveTime = nextTimes[waveNumber];
      bf.waveNumber++;
    } else {
      if (elapsedTime < bf.nextWaveTime) return;

      const size = Math.round((40 + Math.floor(Math.random() * 21)) * this.waveMultiplier);
      this.spawnBerserkerWave(size);

      bf.nextWaveTime = elapsedTime + 20 + Math.random() * 20;
      bf.waveNumber++;
    }
  }

  private spawnBerserkerWave(count: number): void {
    const bf = this.stateManager.getBattlefield();
    const points = this.generateSpawnPoints(count);

    const sharedPaths: Position[][] = points.map((origin) => {
      const angle = Math.random() * Math.PI * 2;
      const d = 20 + Math.random() * 20;
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
    const numPoints = Math.max(1, Math.min(8, Math.ceil(count / 20)));
    const points: Position[] = [];
    let attempts = 0;

    while (points.length < numPoints && attempts < 200) {
      attempts++;

      const edge = Math.floor(Math.random() * 4);
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

      const tooClose = points.some((p) => {
        const dx = p.x - x;
        const dy = p.y - y;
        return dx * dx + dy * dy < 20 * 20;
      });

      if (!tooClose && this.stateManager.isClearTile(x, y)) points.push({ x, y });
    }

    if (points.length === 0) points.push({ x: 5, y: 5 });
    return points;
  }

  private processRest(units: IUnit[], deltaTime: number): void {
    for (const unit of units) {
      if (unit.state !== BehaviorState.REST) continue;
      unit.hp = Math.min(unit.maxHp, unit.hp + REST_HEAL_PER_SEC * deltaTime);
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

  private moveUnit(unit: IUnit, deltaTime: number, grid: TerrainType[][]): void {
    if (unit.state === BehaviorState.FLEE) {
      if (unit.unitType === UnitType.HERO)
        moveHeroRetreat(this.stateManager, unit as IHero, deltaTime, grid);
      else this.moveFlee(unit, deltaTime, grid);
      return;
    }

    if (unit.unitType === UnitType.BERSERKER && !this.battleMode) {
      if (unit.state !== BehaviorState.IDLE) return;

      if (unit.target !== null) {
        const target = this.stateManager.getUnitById(unit.target);
        if (target && target.hp > 0) {
          const dtx = Math.floor(target.position.x);
          const dty = Math.floor(target.position.y);

          const idNum = parseInt(unit.id.replace('unit_', '')) || 0;
          const angle = (idNum * 2.399963) % (Math.PI * 2);
          const r = 1.0 + (idNum % 3) * 0.4;
          let aimX = Math.max(1, Math.min(148, dtx + Math.round(Math.cos(angle) * r)));
          let aimY = Math.max(1, Math.min(148, dty + Math.round(Math.sin(angle) * r)));
          if (!this.stateManager.isClearTile(aimX, aimY)) {
            aimX = dtx;
            aimY = dty;
          }

          const pe = unit.path.length > 0 ? unit.path[unit.path.length - 1] : null;
          if (!pe || pe.x !== aimX || pe.y !== aimY) {
            const st = { x: Math.floor(unit.position.x), y: Math.floor(unit.position.y) };
            unit.path = Pathfinder.findPath(grid, st, { x: aimX, y: aimY });
          }
        } else {
          unit.target = null;
          unit.path = [];
        }
      } else if (unit.path.length === 0) {
        const elapsed = this.stateManager.getBattlefield().elapsedTime;
        const dest = this.patrol.destination(unit.groupId, unit.position, elapsed);
        const dtx = Math.floor(dest.x);
        const dty = Math.floor(dest.y);
        if (Math.floor(unit.position.x) !== dtx || Math.floor(unit.position.y) !== dty) {
          const st = { x: Math.floor(unit.position.x), y: Math.floor(unit.position.y) };
          unit.path = Pathfinder.findPath(grid, st, { x: dtx, y: dty });
          if (unit.path.length === 0) this.patrol.forget(unit.groupId);
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

    const leader = this.isSoldier(unit) ? this.findLeader(unit) : undefined;
    const dest = this.getDestination(unit, leader);
    if (!dest) {
      unit.path = [];
      return;
    }

    if (this.isSoldier(unit) && unit.target === null && leader && leader.path.length === 0) {
      const dx = leader.position.x - unit.position.x;
      const dy = leader.position.y - unit.position.y;
      if (dx * dx + dy * dy <= WARRIOR_ARRIVE_RADIUS * WARRIOR_ARRIVE_RADIUS) {
        unit.path = [];
        return;
      }
    }

    const destTileX = Math.floor(dest.x);
    const destTileY = Math.floor(dest.y);
    const pathEnd = unit.path.length > 0 ? unit.path[unit.path.length - 1] : null;

    if (!pathEnd || pathEnd.x !== destTileX || pathEnd.y !== destTileY) {
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

  // leader: the hero this soldier follows (already checked to be within its sight).
  private getDestination(unit: IUnit, leader: IHero | undefined): Position | null {
    if (unit.target !== null) {
      const target = this.stateManager.getUnitById(unit.target);
      if (target && target.hp > 0) return target.position;
    }

    if (unit.unitType === UnitType.HERO) {
      return (unit as IHero).taskPoint ?? null;
    }
    if (this.isSoldier(unit)) {
      if (leader) return leader.taskPoint ?? null;
      if (this.battleMode) return this.strayDestination(unit);
    }
    return null;
  }

  // A soldier with no hero of its side within sight is a stray: it stays where it is (and
  // fights what comes close) until a hero comes to collect it (regroup order). Only when its
  // side has no heroes left does it attack the nearest enemy, so a battle can still end (D28).
  private strayDestination(unit: IUnit): Position | null {
    const heroLeft = this.stateManager
      .getHeroes()
      .some((h) => h.faction === unit.faction && h.hp > 0);
    if (heroLeft) return null;
    const enemy = findNearestEnemyAnywhere(this.stateManager, unit);
    return enemy ? enemy.position : null;
  }

  private computeSpeed(unit: IUnit, grid: TerrainType[][]): number {
    const xi = Math.floor(unit.position.x);
    const yi = Math.floor(unit.position.y);
    const terrain = grid[yi]?.[xi] ?? TerrainType.MOUNTAIN;
    const terrainMult = terrainSpeed(terrain);
    const hpMult = 0.5 + 0.5 * (unit.hp / unit.maxHp);
    return unit.baseSpeed * hpMult * terrainMult;
  }

  private loop(timestamp: number): void {
    const rawDelta = (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;

    const deltaTime = Math.min(rawDelta, 0.1) * this.speedMultiplier;

    if (!this.paused && !this.isWaitingForAI()) {
      this.update(deltaTime);
      this.stateManager.getBattlefield().elapsedTime += deltaTime;
    }

    const battlefield = this.stateManager.getBattlefield();
    this.renderer.render(battlefield);
    this.minimapRenderer.render(
      battlefield,
      this.renderer.getCamera(),
      this.renderer.getTerrainArt()
    );

    this.rafId = requestAnimationFrame(this.loop.bind(this));
  }
}
