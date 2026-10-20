import { Pathfinder } from './Pathfinder';
import { StateManager } from '../state/StateManager';
import {
  IHero,
  IUnit,
  Position,
  TerrainType,
  TERRAIN_SPEED,
  TERRAIN_SIGHT,
  GRID_SIZE,
  INNER_MIN,
  INNER_MAX,
} from '../types/types';
import { ATTACK_CHASE_TILES, FLEE_MAX_TURN_DEGREES, FLEE_SPEED_MULT } from './Rules';

// Small queries and movement helpers shared by the engine and its hero modules.

// Mountains are impassable for pathfinding, but a unit can still clip a mountain tile's
// corner while moving. Speed 0 there would trap it forever, so it crawls out instead.
const MOUNTAIN_ESCAPE_SPEED = 0.5;
// A fleeing unit stays at least half a tile inside the map
const POS_MIN = 0.5;
const POS_MAX = GRID_SIZE - 0.5;
// A unit this close to a tile's centre is at (or next to) that tile
export const NEAR_TILE_DISTANCE = 1.5;
// nearestReachableTile looks this many tiles around the target (Chebyshev rings) before giving up
const REACHABLE_SEARCH_TILES = 40;

export function terrainSpeed(terrain: TerrainType): number {
  return terrain === TerrainType.MOUNTAIN
    ? MOUNTAIN_ESCAPE_SPEED
    : TERRAIN_SPEED[TerrainType[terrain]];
}

// Sight reduced by the terrain the unit stands on.
export function effectiveSight(sm: StateManager, unit: IUnit): number {
  const { grid } = sm.getBattlefield();
  const tx = Math.floor(unit.position.x);
  const ty = Math.floor(unit.position.y);
  const terrain = grid[ty]?.[tx] ?? TerrainType.OPEN;
  return unit.sight * (TERRAIN_SIGHT[TerrainType[terrain]] ?? 1.0);
}

// Nearest living enemy within the unit's sight. Uses the fast ring search (D31); only
// when several enemies are at exactly the same distance does it fall back to the full scan,
// whose order picks the same enemy as the original code.
export function findNearestEnemy(sm: StateManager, unit: IUnit): IUnit | null {
  const { x, y } = unit.position;
  const sight = effectiveSight(sm, unit);
  const fast = sm.nearestEnemyInRadius(x, y, sight, unit.faction);
  return sm.wasNearestTied() ? sm.nearestEnemyByScan(x, y, sight, unit.faction) : fast;
}

// D55: the enemy an attack or lead order goes for: the nearest enemy in the hero's sight, or,
// with none in sight, the one it went for last while that one lives and is within
// ATTACK_CHASE_TILES (it stepped out of sight: the hero fell back behind its soldiers, walked into
// a forest or around a mountain). null: the hero stays where it is.
export function attackTarget(sm: StateManager, hero: IHero): IUnit | null {
  const seen = findNearestEnemy(sm, hero);
  if (seen) {
    hero.attackTargetId = seen.id;
    return seen;
  }
  const last = chasedEnemy(sm, hero);
  if (!last) hero.attackTargetId = null;
  return last;
}

// Whether an attack or lead order would have an enemy to go for now (reads only)
export function hasAttackTarget(sm: StateManager, hero: IHero): boolean {
  return findNearestEnemy(sm, hero) !== null || chasedEnemy(sm, hero) !== null;
}

// The enemy the hero went for last, while it lives and is within ATTACK_CHASE_TILES
function chasedEnemy(sm: StateManager, hero: IHero): IUnit | null {
  if (hero.attackTargetId === null) return null;
  const last = sm.getUnitById(hero.attackTargetId);
  if (!last || last.hp <= 0) return null;
  const d = Math.hypot(last.position.x - hero.position.x, last.position.y - hero.position.y);
  return d <= ATTACK_CHASE_TILES ? last : null;
}

// Nearest living enemy anywhere on the map.
export function findNearestEnemyAnywhere(sm: StateManager, unit: IUnit): IUnit | null {
  let nearest: IUnit | null = null;
  let minD2 = Infinity;
  for (const other of sm.getBattlefield().units) {
    if (other.faction === unit.faction || other.hp <= 0) continue;
    const dx = other.position.x - unit.position.x;
    const dy = other.position.y - unit.position.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < minD2) {
      minD2 = d2;
      nearest = other;
    }
  }
  return nearest;
}

export function tileOf(pos: Position): Position {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y) };
}

// Distance from a position to the centre of a tile
export function distToTileCentre(pos: Position, tile: Position): number {
  return Math.hypot(pos.x - (tile.x + 0.5), pos.y - (tile.y + 0.5));
}

// Sum of the positions of the living enemies within radius of the unit, and their number.
export function enemyPositionSum(
  sm: StateManager,
  unit: IUnit,
  radius: number
): { x: number; y: number; n: number } {
  let x = 0;
  let y = 0;
  let n = 0;
  sm.forEachInRadius(unit.position.x, unit.position.y, radius, (other) => {
    if (other.hp <= 0 || other.faction === unit.faction) return;
    x += other.position.x;
    y += other.position.y;
    n++;
  });
  return { x, y, n };
}

// Targets inside mountains or in enclosed pockets are unreachable; use the closest
// tile of the map's main walkable region instead.
export function nearestReachableTile(sm: StateManager, target: Position): Position {
  const t = tileOf(target);
  for (let r = 0; r <= REACHABLE_SEARCH_TILES; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = t.x + dx;
        const y = t.y + dy;
        if (x < INNER_MIN || y < INNER_MIN || x > INNER_MAX || y > INNER_MAX) continue;
        if (sm.isInMainRegion(x, y)) return { x, y };
      }
    }
  }
  return t;
}

// Battle mode: whether a step (or a push) from (ox, oy) to (nx, ny) is allowed: it stays on its
// tile, or ends on a tile the pathfinder can use in the same walkable region. Regions join through
// tile edges, while a step can cross the corner where two mountain buffers meet: that put units
// into pockets no path reaches, and whole armies then stood in front of them (CASES 14.x).
export function canStep(
  grid: TerrainType[][],
  ox: number,
  oy: number,
  nx: number,
  ny: number
): boolean {
  const fx = Math.floor(ox);
  const fy = Math.floor(oy);
  const tx = Math.floor(nx);
  const ty = Math.floor(ny);
  if (tx === fx && ty === fy) return true;
  if (Pathfinder.isBlocked(grid, tx, ty)) return false;
  return Pathfinder.sameRegion(grid, fx, fy, tx, ty);
}

// A fleeing soldier looks this far ahead (or one flight step, if longer) for a blocked way
const FLEE_LOOK_TILES = 0.6;

// D57: whether a flight in this direction can go on, turning at most FLEE_MAX_TURN_DEGREES (in
// steps of 22.5 degrees): the point a step ahead must be on the map and not blocked (a mountain
// or next to one)
export function fleeWayOpen(
  unit: IUnit,
  baseAngle: number,
  deltaTime: number,
  grid: TerrainType[][]
): boolean {
  const terrain =
    grid[Math.floor(unit.position.y)]?.[Math.floor(unit.position.x)] ?? TerrainType.OPEN;
  const look = Math.max(
    FLEE_LOOK_TILES,
    unit.baseSpeed * terrainSpeed(terrain) * FLEE_SPEED_MULT * deltaTime
  );
  const max = (FLEE_MAX_TURN_DEGREES * Math.PI) / 180;
  for (let turn = 0; turn <= max + 1e-9; turn += Math.PI / 8) {
    for (const angle of turn === 0 ? [baseAngle] : [baseAngle + turn, baseAngle - turn]) {
      const x = unit.position.x + Math.cos(angle) * look;
      const y = unit.position.y + Math.sin(angle) * look;
      if (x < POS_MIN || y < POS_MIN || x > POS_MAX || y > POS_MAX) continue;
      if (!Pathfinder.isBlocked(grid, Math.floor(x), Math.floor(y))) return true;
    }
  }
  return false;
}

// Flee-speed step in the given direction, trying nearby angles if the way is blocked.
export function stepToward(
  sm: StateManager,
  unit: IUnit,
  baseAngle: number,
  deltaTime: number,
  grid: TerrainType[][],
  keepRegion = false
): void {
  const xi = Math.floor(unit.position.x);
  const yi = Math.floor(unit.position.y);
  const terrain = grid[yi]?.[xi] ?? TerrainType.MOUNTAIN;
  const step = unit.baseSpeed * terrainSpeed(terrain) * FLEE_SPEED_MULT * deltaTime;

  const offsets = [
    0,
    Math.PI / 8,
    -Math.PI / 8,
    Math.PI / 4,
    -Math.PI / 4,
    Math.PI / 2,
    -Math.PI / 2,
  ];
  for (const offset of offsets) {
    const angle = baseAngle + offset;
    const newX = Math.max(POS_MIN, Math.min(POS_MAX, unit.position.x + Math.cos(angle) * step));
    const newY = Math.max(POS_MIN, Math.min(POS_MAX, unit.position.y + Math.sin(angle) * step));
    const nx = Math.floor(newX);
    const ny = Math.floor(newY);
    // keepRegion (battle mode): never step into another walkable region through the corner
    // where two mountain buffers meet; fleeing units ended up in pockets no path reaches, and
    // the army chasing them stood in front (CASES 14.x)
    const sameTile = nx === xi && ny === yi;
    if (
      sm.isClearTile(nx, ny) &&
      (!keepRegion || sameTile || Pathfinder.sameRegion(grid, xi, yi, nx, ny))
    ) {
      unit.position.x = newX;
      unit.position.y = newY;
      return;
    }
  }
}
