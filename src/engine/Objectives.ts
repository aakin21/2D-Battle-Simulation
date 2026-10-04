import { StateManager } from '../state/StateManager';
import { Base, BehaviorState, ControlPoint, Faction, IUnit } from '../types/types';
import {
  ATTACK_INTERVAL,
  BASE_RADIUS,
  COMBAT_RANGE,
  CONTROL_POINTS_PER_SEC,
  CONTROL_RADIUS,
} from './Rules';

// Battle objectives (D30): control points scored by majority, and bases that units attack.

export type EndReason = 'elimination' | 'base' | 'points' | 'time';

const other = (f: Faction) => (f === Faction.FRIENDLY ? Faction.ENEMY : Faction.FRIENDLY);

export function enemyBase(sm: StateManager, faction: Faction): Base | undefined {
  return sm.getBattlefield().objective.bases.find((b) => b.faction === other(faction));
}

export function ownBase(sm: StateManager, faction: Faction): Base | undefined {
  return sm.getBattlefield().objective.bases.find((b) => b.faction === faction);
}

// Units of each side near a point (fleeing units do not count).
export function pointCounts(
  sm: StateManager,
  point: ControlPoint
): { friendly: number; enemy: number } {
  let friendly = 0;
  let enemy = 0;
  sm.forEachInRadius(point.position.x + 0.5, point.position.y + 0.5, CONTROL_RADIUS, (u) => {
    if (u.hp <= 0 || u.state === BehaviorState.FLEE) return;
    if (u.faction === Faction.FRIENDLY) friendly++;
    else enemy++;
  });
  return { friendly, enemy };
}

// Control mode: every moment, the side with more units near a point scores for it.
export function updateControl(sm: StateManager, dt: number): void {
  const o = sm.getBattlefield().objective;
  for (const p of o.points) {
    const c = pointCounts(sm, p);
    p.holder =
      c.friendly > c.enemy ? Faction.FRIENDLY : c.enemy > c.friendly ? Faction.ENEMY : null;
    if (p.holder === Faction.FRIENDLY) o.scores.friendly += CONTROL_POINTS_PER_SEC * dt;
    else if (p.holder === Faction.ENEMY) o.scores.enemy += CONTROL_POINTS_PER_SEC * dt;
  }
}

// Base mode: units close enough to the enemy base hit it on their attack cooldown, unless
// they are already fighting a unit, fleeing or resting. Bases do not hit back.
export function damageBases(sm: StateManager, units: IUnit[], dt: number): void {
  const bases = sm.getBattlefield().objective.bases;
  if (bases.length === 0) return;
  const reach = BASE_RADIUS + COMBAT_RANGE;
  for (const u of units) {
    if (u.hp <= 0 || u.state !== BehaviorState.IDLE) continue;
    const base = bases.find((b) => b.faction !== u.faction);
    if (!base || base.hp <= 0) continue;
    const dx = base.position.x + 0.5 - u.position.x;
    const dy = base.position.y + 0.5 - u.position.y;
    if (dx * dx + dy * dy > reach * reach) continue;
    u.attackCooldown -= dt;
    if (u.attackCooldown > 0) continue;
    base.hp = Math.max(0, base.hp - u.damage);
    u.attackCooldown = ATTACK_INTERVAL;
  }
}

// Objective-based end of a match, or null if it goes on. Elimination is checked by the engine.
export function objectiveEnd(
  sm: StateManager
): { winner: Faction | null; reason: EndReason } | null {
  const bf = sm.getBattlefield();
  const o = bf.objective;
  if (o.mode === 'base') {
    const fallen = o.bases.filter((b) => b.hp <= 0);
    if (fallen.length === 2) return { winner: null, reason: 'base' };
    if (fallen.length === 1) return { winner: other(fallen[0].faction), reason: 'base' };
  }
  if (o.timeLimit !== null && bf.elapsedTime >= o.timeLimit) {
    // Time up: control is decided on points, every mode then on total HP left.
    const reason: EndReason = o.mode === 'control' ? 'points' : 'time';
    if (o.mode === 'control' && o.scores.friendly !== o.scores.enemy) {
      return {
        winner: o.scores.friendly > o.scores.enemy ? Faction.FRIENDLY : Faction.ENEMY,
        reason,
      };
    }
    let fh = 0;
    let eh = 0;
    for (const u of bf.units) {
      if (u.faction === Faction.FRIENDLY) fh += u.hp;
      else eh += u.hp;
    }
    return { winner: fh > eh ? Faction.FRIENDLY : eh > fh ? Faction.ENEMY : null, reason };
  }
  return null;
}
