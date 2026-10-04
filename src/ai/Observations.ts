import { StateManager } from '../state/StateManager';
import { Faction, IHero, IUnit, BehaviorState, UnitType } from '../types/types';

// Values computed by code for the AI layers (R5: code computes, the AI judges).

export const LOCAL_RADIUS = 15; // tiles around a hero for local counts and force ratio

export interface GroupStats {
  followers: number; // soldiers whose nearest own hero (within its sight) is this hero
  avgHpPercent: number;
  avgCourage: number;
  fleeing: number;
}

// Followers of every hero of one side, using the same rule the engine uses for following:
// the nearest living hero of the side within that hero's sight.
export function groupStats(sm: StateManager, faction: Faction): Map<string, GroupStats> {
  const heroes = sm.getHeroes().filter((h) => h.faction === faction && h.hp > 0);
  const acc = new Map<string, { n: number; hp: number; courage: number; fleeing: number }>();
  for (const h of heroes) acc.set(h.id, { n: 0, hp: 0, courage: 0, fleeing: 0 });

  for (const u of sm.getBattlefield().units) {
    if (u.faction !== faction || u.unitType === UnitType.HERO || u.hp <= 0) continue;
    let best: IHero | undefined;
    let bestD2 = Infinity;
    for (const h of heroes) {
      const d2 = (h.position.x - u.position.x) ** 2 + (h.position.y - u.position.y) ** 2;
      if (d2 <= h.sight * h.sight && d2 < bestD2) {
        bestD2 = d2;
        best = h;
      }
    }
    if (!best) continue;
    const a = acc.get(best.id)!;
    a.n++;
    a.hp += u.hp / u.maxHp;
    a.courage += u.courage;
    if (u.state === BehaviorState.FLEE) a.fleeing++;
  }

  const out = new Map<string, GroupStats>();
  for (const [id, a] of acc) {
    out.set(id, {
      followers: a.n,
      avgHpPercent: a.n ? Math.round((100 * a.hp) / a.n) : 0,
      avgCourage: a.n ? Math.round(a.courage / a.n) : 0,
      fleeing: a.fleeing,
    });
  }
  return out;
}

// Strength around a unit, measured as total remaining HP of each side within the radius.
// ratio > 1: we are stronger here. Infinity when no enemy is near.
export function localForce(
  sm: StateManager,
  unit: IUnit,
  radius = LOCAL_RADIUS
): { allies: number; enemies: number; ratio: number } {
  let allyHp = 0;
  let enemyHp = 0;
  let allies = 0;
  let enemies = 0;
  sm.forEachInRadius(unit.position.x, unit.position.y, radius, (u) => {
    if (u.hp <= 0) return;
    if (u.faction === unit.faction) {
      allyHp += u.hp;
      if (u.id !== unit.id) allies++;
    } else {
      enemyHp += u.hp;
      enemies++;
    }
  });
  return { allies, enemies, ratio: enemyHp > 0 ? allyHp / enemyHp : Infinity };
}

// Ratio rounded for prompts; "no enemies" instead of Infinity.
export function formatRatio(ratio: number): number | string {
  return Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : 'no enemies near';
}

// Total remaining HP of each side, for the overall force ratio.
export function armyHp(sm: StateManager): { friendly: number; enemy: number } {
  let friendly = 0;
  let enemy = 0;
  for (const u of sm.getBattlefield().units) {
    if (u.hp <= 0) continue;
    if (u.faction === Faction.FRIENDLY) friendly += u.hp;
    else enemy += u.hp;
  }
  return { friendly, enemy };
}
