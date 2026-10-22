import { StateManager } from '../state/StateManager';
import { Pathfinder } from '../engine/Pathfinder';
import { viaReached } from '../engine/HeroCommands';
import { MAX_VIA } from '../engine/Rules';
import { nearestReachableTile, tileOf } from '../engine/UnitHelpers';
import { Faction, GRID_SIZE, HeroCommand, IHero, Position } from '../types/types';
import { distance, VIEW_RADIUS } from './Observations';

// D60: the tactical layer's way around enemies. The pathfinder's paths ignore enemy units, so a
// hero sent across the map often walks into an enemy army. Here code works out a way to the same
// place that keeps away from the enemy units on the map; the tactical layer only chooses whether
// to take it (continue_around), as it chooses every other option.

// Tiles within AVOID_TILES of an enemy unit cost AVOID_COST more per step: a soldier fights what
// it sees within 10 tiles (it leaves its hero's way), so the way keeps two tiles more than that
export const AVOID_TILES = 12;
const AVOID_COST = 6;
const STAMP_CELL = 3; // enemy units are stamped once per 3×3-tile cell they stand in
const CHECK_STEP = 2; // tiles between the points at which a way is checked

// Extra cost per tile near the living enemy units of `faction`'s opponent (the side's view of the
// threats), for Pathfinder.findPathAvoiding
export function threatCosts(sm: StateManager, faction: Faction): Uint8Array {
  const costs = new Uint8Array(GRID_SIZE * GRID_SIZE);
  const stamped = new Set<number>();
  const reach = AVOID_TILES + STAMP_CELL * 0.71;
  for (const u of sm.getBattlefield().units) {
    if (u.faction === faction || u.hp <= 0) continue;
    const cx = Math.floor(u.position.x / STAMP_CELL);
    const cy = Math.floor(u.position.y / STAMP_CELL);
    const key = cy * GRID_SIZE + cx;
    if (stamped.has(key)) continue;
    stamped.add(key);
    // Around the cell's centre, with the cell's half diagonal added so every unit in it is covered
    const mx = (cx + 0.5) * STAMP_CELL;
    const my = (cy + 0.5) * STAMP_CELL;
    const reach2 = reach * reach;
    for (let y = Math.max(0, Math.floor(my - reach)); y <= Math.min(GRID_SIZE - 1, my + reach); y++)
      for (
        let x = Math.max(0, Math.floor(mx - reach));
        x <= Math.min(GRID_SIZE - 1, mx + reach);
        x++
      )
        if ((x + 0.5 - mx) ** 2 + (y + 0.5 - my) ** 2 <= reach2)
          costs[y * GRID_SIZE + x] = AVOID_COST;
  }
  return costs;
}

// Points every CHECK_STEP tiles along a way of corners from `from`, up to `upTo` tiles
function along(from: Position, corners: Position[], upTo: number): Position[] {
  const points: Position[] = [];
  let prev = from;
  let walked = 0;
  for (const next of corners) {
    const len = distance(prev, next);
    for (let t = CHECK_STEP; t <= len && walked + t <= upTo; t += CHECK_STEP)
      points.push({
        x: prev.x + ((next.x - prev.x) * t) / len,
        y: prev.y + ((next.y - prev.y) * t) / len,
      });
    walked += len;
    prev = next;
    if (walked >= upTo) break;
  }
  if (walked < upTo) points.push(prev);
  return points;
}

// How many of the checked points of a way's first VIEW_RADIUS tiles lie near enemy units
function nearEnemies(from: Position, corners: Position[], costs: Uint8Array): number {
  let n = 0;
  for (const p of along(from, corners, VIEW_RADIUS))
    if (costs[Math.floor(p.y) * GRID_SIZE + Math.floor(p.x)] > 0) n++;
  return n;
}

function length(from: Position, corners: Position[]): number {
  let total = 0;
  let prev = from;
  for (const c of corners) {
    total += distance(prev, c);
    prev = c;
  }
  return total;
}

export interface Detour {
  command: HeroCommand & { type: 'move' };
  length: number; // tiles along the way around
  direct: number; // tiles along the pathfinder's way
  nearDirect: number; // checked points near enemies within VIEW_RADIUS: on the pathfinder's way
  nearAround: number; // and on the way around
}

// The way around enemies to the point the commander's move order leads to next, then on along the
// rest of its route: a move order with via points (D60). Null when the order is no move, the
// pathfinder's way passes no enemy within VIEW_RADIUS, or the way around does not at least halve
// how much of it lies near enemies there.
export function detourFor(sm: StateManager, hero: IHero, costs: Uint8Array): Detour | null {
  const order = hero.lastLlmCommand;
  if (order?.type !== 'move') return null;
  // The rest of the commander's route: its via points not reached yet, then its target
  const done = viaReached(hero, order.via ?? [], hero.lastLlmTime);
  const rest = [...(order.via ?? []).slice(done), order.target];
  const next = nearestReachableTile(sm, rest[0]);
  const grid = sm.getBattlefield().grid;
  const here = tileOf(hero.position);
  const direct = Pathfinder.findPath(grid, here, next);
  if (direct.length === 0 || nearEnemies(here, direct, costs) === 0) return null;
  const around = Pathfinder.findPathAvoiding(grid, here, next, costs);
  if (around.length === 0) return null;
  const nearDirect = nearEnemies(here, direct, costs);
  // The way around the hero already walks, if Jev chose it before and the rest of it still keeps
  // away: offered again unchanged, so choosing it again is no new order (a new one each request
  // made a fighting hero break off every 4 s, D27)
  const walking = hero.command;
  if (
    hero.commandSource === 'jev' &&
    walking?.type === 'move' &&
    walking.via &&
    walking.target.x === order.target.x &&
    walking.target.y === order.target.y
  ) {
    const left = [
      ...walking.via.slice(viaReached(hero, walking.via, hero.commandTime)),
      walking.target,
    ];
    const near = nearEnemies(here, left, costs);
    if (near * 2 <= nearDirect)
      return {
        command: walking,
        length: Math.round(length(here, left)),
        direct: Math.round(length(here, direct)),
        nearDirect,
        nearAround: near,
      };
  }
  const nearAround = nearEnemies(here, around, costs);
  // Offered only when clearly better: in a real match ways that passed nearly as close (19 points
  // near enemies against 17) were offered, a longer walk for little (out/probe-around.ts)
  if (nearAround * 2 > nearDirect) return null;
  // The corners before the point become via points, then the commander's remaining via points.
  // The way around comes first: cut short, it would lead back into the enemies; a commander's
  // route leaves room for it (MAX_LLM_VIA), and the tactical layer decides again within seconds
  const via = [...around.slice(0, -1), ...rest.slice(0, -1)].slice(0, MAX_VIA);
  const target = rest[rest.length - 1];
  const command: HeroCommand & { type: 'move' } = via.length
    ? { type: 'move', target, via }
    : { type: 'move', target };
  return {
    command,
    length: Math.round(length(here, around)),
    direct: Math.round(length(here, direct)),
    nearDirect,
    nearAround,
  };
}
