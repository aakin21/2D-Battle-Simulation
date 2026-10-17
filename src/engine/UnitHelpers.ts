import { StateManager } from '../state/StateManager';
import {
  IUnit,
  Position,
  TerrainType,
  TERRAIN_SPEED,
  TERRAIN_SIGHT,
  GRID_SIZE,
  INNER_MIN,
  INNER_MAX,
} from '../types/types';
import { FLEE_SPEED_MULT } from './Rules';

// Small queries and movement helpers shared by the engine and its hero modules.

// Mountains are impassable for pathfinding, but a unit can still clip a mountain tile's
// corner while moving. Speed 0 there would trap it forever, so it crawls out instead.
const MOUNTAIN_ESCAPE_SPEED = 0.5;
// A fleeing unit stays at least half a tile inside the map
const POS_MIN = 0.5;
const POS_MAX = GRID_SIZE - 0.5;
// A unit this close to a tile's centre is at (or next to) that tile
export const NEAR_TILE_DISTANCE = 1.5;

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
// when several enemies are at exactly the same distance does it fall back to the full scan
// below, whose order picks the same enemy as the original code.
export function findNearestEnemy(sm: StateManager, unit: IUnit): IUnit | null {
  const sight = effectiveSight(sm, unit);
  const fast = sm.nearestEnemyInRadius(unit.position.x, unit.position.y, sight, unit.faction);
  if (!sm.wasNearestTied()) return fast;

  let nearest: IUnit | null = null;
  let minDist2 = Infinity;

  sm.forEachInRadius(unit.position.x, unit.position.y, sight, (other) => {
    if (other.faction === unit.faction || other.hp <= 0) return;
    const dx = other.position.x - unit.position.x;
    const dy = other.position.y - unit.position.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < minDist2) {
      minDist2 = d2;
      nearest = other;
    }
  });

  return nearest;
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
  for (let r = 0; r <= 40; r++) {
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

// Flee-speed step in the given direction, trying nearby angles if the way is blocked.
export function stepToward(
  sm: StateManager,
  unit: IUnit,
  baseAngle: number,
  deltaTime: number,
  grid: TerrainType[][]
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
    if (sm.isClearTile(Math.floor(newX), Math.floor(newY))) {
      unit.position.x = newX;
      unit.position.y = newY;
      return;
    }
  }
}
