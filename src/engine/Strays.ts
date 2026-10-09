import { StateManager } from '../state/StateManager';
import { Faction, IHero, IUnit, Position, BehaviorState, UnitType } from '../types/types';

// Stray soldiers (D28): soldiers with no hero of their side within that hero's sight, so
// they follow nobody. Grouped into clusters so the AI layers get a few lines instead of a
// list of units (R5), and so "regroup" can send a hero to the nearest group.

export const STRAY_LINK_DISTANCE = 6; // soldiers closer than this belong to the same cluster

export interface StrayCluster {
  center: Position;
  soldiers: number;
  avgHpPercent: number;
  avgCourage: number;
  fleeing: number;
}

export function isStray(sm: StateManager, unit: IUnit): boolean {
  for (const h of sm.getHeroes()) {
    if (h.faction !== unit.faction || h.hp <= 0) continue;
    const d2 = (h.position.x - unit.position.x) ** 2 + (h.position.y - unit.position.y) ** 2;
    if (d2 <= h.sight * h.sight) return false;
  }
  return true;
}

// Clusters of stray soldiers of one side, largest first.
// Neighbours are looked up in buckets of the link distance (a neighbour is always in the 3×3
// buckets around a soldier) instead of scanning every stray, and are taken in index order, so
// the clusters, their members' order and their centres are exactly those of a plain scan.
// With ~1,500 strays (2,000 soldiers per side at the start) a plain scan took ~10 ms per call.
export function strayClusters(sm: StateManager, faction: Faction): StrayCluster[] {
  const strays = sm
    .getBattlefield()
    .units.filter(
      (u) => u.faction === faction && u.unitType !== UnitType.HERO && u.hp > 0 && isStray(sm, u)
    );
  const seen = new Uint8Array(strays.length);
  const clusters: StrayCluster[] = [];
  const link2 = STRAY_LINK_DISTANCE * STRAY_LINK_DISTANCE;
  const cellOf = (v: number) => Math.floor(v / STRAY_LINK_DISTANCE);
  const key = (cx: number, cy: number) => cy * 1024 + cx; // cells per row are far below 1024
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < strays.length; i++) {
    const k = key(cellOf(strays[i].position.x), cellOf(strays[i].position.y));
    const bucket = buckets.get(k);
    if (bucket) bucket.push(i);
    else buckets.set(k, [i]);
  }
  const found: number[] = [];

  for (let i = 0; i < strays.length; i++) {
    if (seen[i]) continue;
    const members: IUnit[] = [];
    const queue = [i];
    seen[i] = 1;
    while (queue.length > 0) {
      const a = strays[queue.pop()!];
      members.push(a);
      found.length = 0;
      const cx = cellOf(a.position.x);
      const cy = cellOf(a.position.y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const j of buckets.get(key(cx + dx, cy + dy)) ?? []) {
            if (seen[j]) continue;
            const b = strays[j];
            if ((a.position.x - b.position.x) ** 2 + (a.position.y - b.position.y) ** 2 <= link2)
              found.push(j);
          }
        }
      }
      found.sort((p, q) => p - q);
      for (const j of found) {
        seen[j] = 1;
        queue.push(j);
      }
    }
    const n = members.length;
    clusters.push({
      center: {
        x: members.reduce((s, u) => s + u.position.x, 0) / n,
        y: members.reduce((s, u) => s + u.position.y, 0) / n,
      },
      soldiers: n,
      avgHpPercent: Math.round((100 * members.reduce((s, u) => s + u.hp / u.maxHp, 0)) / n),
      avgCourage: Math.round(members.reduce((s, u) => s + u.courage, 0) / n),
      fleeing: members.filter((u) => u.state === BehaviorState.FLEE).length,
    });
  }
  return clusters.sort((a, b) => b.soldiers - a.soldiers);
}

// The stray cluster a hero should collect: the nearest one, preferring bigger groups
// (distance divided by the square root of the group size).
export function regroupTarget(clusters: StrayCluster[], hero: IHero): StrayCluster | null {
  let best: StrayCluster | null = null;
  let bestScore = Infinity;
  for (const c of clusters) {
    const d = Math.hypot(c.center.x - hero.position.x, c.center.y - hero.position.y);
    const score = d / Math.sqrt(c.soldiers);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
