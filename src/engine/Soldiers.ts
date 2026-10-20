import { StateManager } from '../state/StateManager';
import { IUnit, IHero, UnitType, UNIT_STATS } from '../types/types';
import {
  WOUND_STEP,
  WOUND_PENALTY,
  ALLY_SHARE_HIGH,
  ALLY_SHARE_HIGH_BONUS,
  ALLY_SHARE_LOW,
  ALLY_SHARE_LOW_PENALTY,
  ALLY_SHARE_VERY_LOW,
  ALLY_SHARE_VERY_LOW_PENALTY,
  SEPARATION_RADIUS,
} from './Rules';
import { effectiveSight } from './UnitHelpers';

// Soldiers: the units that follow a hero and use courage. Warriors in classic mode; in battle
// mode berserkers too (D35, D42).

const WARRIOR_ARRIVE_RADIUS = 2;
// Battle mode: the arrive radius of a group of n soldiers is SEPARATION_RADIUS ×
// sqrt(GROUP_PACKING × n / π) × GROUP_SPREAD_MARGIN + GROUP_ARRIVE_EXTRA (tiles): about the radius
// of the disc n units take up at their spacing, with some room to spare
const GROUP_PACKING = 0.87;
const GROUP_SPREAD_MARGIN = 1.15;
const GROUP_ARRIVE_EXTRA = 1;
// Courage is kept within this range
const COURAGE_MIN = 0;
const COURAGE_MAX = 100;

export function isSoldier(unit: IUnit, battleMode: boolean): boolean {
  return unit.unitType === UnitType.WARRIOR || (battleMode && unit.unitType === UnitType.BERSERKER);
}

// Nearest living hero of the unit's own side within maxDist (or within the hero's
// sight when maxDist is not given). In classic mode this is the single hero.
export function findLeader(
  sm: StateManager,
  unit: IUnit,
  maxDist?: (hero: IHero) => number
): IHero | undefined {
  let best: IHero | undefined;
  let bestD2 = Infinity;
  for (const hero of sm.getHeroes()) {
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

export const charismaReach = (hero: IHero): number => hero.charismaRadius;

// Courage (D14): computed here only, from wounds, the share of allies in sight and a hero's
// charisma. counts is a reused [friendly, enemy] buffer.
export function updateCourage(
  sm: StateManager,
  unit: IUnit,
  battleMode: boolean,
  counts: Int32Array
): void {
  if (!isSoldier(unit, battleMode)) return;

  // Soldiers are warriors in classic mode; in battle mode both sides use warrior stats
  // (D19), courage included.
  const base = UNIT_STATS.WARRIOR.courage;

  const hpLostFraction = 1 - unit.hp / unit.maxHp;
  const woundedPenalty = -Math.floor(hpLostFraction / WOUND_STEP) * WOUND_PENALTY;

  // Living units in sight per faction, the unit itself included (D31: same counts as a
  // full scan, computed from per-cell counters)
  const sight = effectiveSight(sm, unit);
  sm.countByFactionInRadius(unit.position.x, unit.position.y, sight, counts);
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

  const charismaHero = findLeader(sm, unit, charismaReach);
  const heroBonus = charismaHero ? charismaHero.charismaBonus : 0;

  unit.courage = Math.max(
    COURAGE_MIN,
    Math.min(COURAGE_MAX, base + woundedPenalty + ratioModifier + heroBonus)
  );
}

// Soldiers following each hero, counted once per frame (battle mode), and how close to its
// standing hero a soldier stops
export class Followers {
  private counts = new Map<string, number>();

  // Battle mode only: classic soldiers stop at WARRIOR_ARRIVE_RADIUS whatever their number
  count(sm: StateManager, units: IUnit[]): void {
    this.counts.clear();
    for (const unit of units) {
      if (!isSoldier(unit, true) || unit.hp <= 0) continue;
      const leader = findLeader(sm, unit);
      if (leader) this.counts.set(leader.id, (this.counts.get(leader.id) ?? 0) + 1);
    }
  }

  // Units take up room in battle mode, so a big group cannot all reach the hero: the radius
  // grows with the ground the group covers, or the outer soldiers keep walking in while the push
  // of their neighbours sends them back, and the whole group shakes (CASES 14.x). Classic keeps
  // Phase 1 (D19).
  arriveRadius(leader: IHero, battleMode: boolean): number {
    if (!battleMode) return WARRIOR_ARRIVE_RADIUS;
    const n = this.counts.get(leader.id) ?? 0;
    const spread =
      SEPARATION_RADIUS * Math.sqrt((GROUP_PACKING * n) / Math.PI) * GROUP_SPREAD_MARGIN +
      GROUP_ARRIVE_EXTRA;
    return Math.max(WARRIOR_ARRIVE_RADIUS, spread);
  }
}
