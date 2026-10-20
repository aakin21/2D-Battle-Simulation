import { StateManager } from '../state/StateManager';
import { Base, BehaviorState, ControlPoint, Faction, IUnit } from '../types/types';
import {
  ATTACK_INTERVAL,
  BASE_RADIUS,
  COMBAT_RANGE,
  CONTROL_CAPTURE_SECONDS,
  CONTROL_POINTS_PER_SEC,
  CONTROL_RADIUS,
} from './Rules';
import { opponent } from './Sides';

// Battle objectives (D30): control points scored by majority, and bases that units attack.

export type EndReason = 'elimination' | 'base' | 'points' | 'time';

export function enemyBase(sm: StateManager, faction: Faction): Base | undefined {
  return sm.getBattlefield().objective.bases.find((b) => b.faction === opponent(faction));
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

// Control mode: the side with more units near a point holds it, and scores for it, once it has
// had the majority for CONTROL_CAPTURE_SECONDS in a row; losing the majority (or a tie) ends the
// hold at once.
export function updateControl(sm: StateManager, dt: number): void {
  const bf = sm.getBattlefield();
  const o = bf.objective;
  for (const p of o.points) {
    const c = pointCounts(sm, p);
    const leader =
      c.friendly > c.enemy ? Faction.FRIENDLY : c.enemy > c.friendly ? Faction.ENEMY : null;
    if (leader !== p.leader) {
      p.leader = leader;
      p.leaderSince = bf.elapsedTime;
    }
    p.holder =
      leader !== null && bf.elapsedTime - p.leaderSince >= CONTROL_CAPTURE_SECONDS ? leader : null;
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

// Points as shown and as they decide the match: whole points earned so far, so a match never
// goes to a side by a fraction of a point the scoreboard does not show
export function wholePoints(score: number): number {
  return Math.floor(score);
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
    if (fallen.length === 1) return { winner: opponent(fallen[0].faction), reason: 'base' };
  }
  if (o.timeLimit !== null && bf.elapsedTime >= o.timeLimit) {
    // Time up: control is decided on points alone, equal points are a draw (D55); the other
    // modes on total HP left.
    if (o.mode === 'control') {
      const friendly = wholePoints(o.scores.friendly);
      const enemy = wholePoints(o.scores.enemy);
      return {
        winner: friendly > enemy ? Faction.FRIENDLY : enemy > friendly ? Faction.ENEMY : null,
        reason: 'points',
      };
    }
    const reason: EndReason = 'time';
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
