import { Faction, GRID_SIZE, Objective, Position, TerrainType } from '../types/types';
import { Pathfinder, NO_REGION } from '../engine/Pathfinder';

// Where a battle starts on a map, from its terrain alone (nothing random here): the map's main
// walkable region, the objectives (D30), each hero's slot and each side's soldier area.
// StateManager places a run with it; Match setup's map preview draws the same places.

// The column each side's heroes start on (west = friendly, east = enemy)
export const WEST_HERO_COLUMN = 20;
export const EAST_HERO_COLUMN = 129;
// Soldiers start at random tiles within this many columns of their side's hero column, over the
// full height of the map
export const SPAWN_AREA_HALF_WIDTH = 20;
// A hero starts on a clear tile in a square around its slot on the side's edge, grown from this
// half-width up to the maximum until it holds one
export const HERO_SPOT_RADIUS = 3;
export const HERO_SPOT_MAX_RADIUS = 40;
// D30: where the objectives go (each on the nearest tile of the main walkable region): control
// points A (north) and B (south) on the centre line, one base per side at its start area
const CONTROL_POINT_A: Position = { x: 75, y: 45 };
const CONTROL_POINT_B: Position = { x: 75, y: 105 };
const WEST_BASE: Position = { x: 14, y: 75 };
const EAST_BASE: Position = { x: 135, y: 75 };

// The largest of the pathfinder's walkable regions (same flood fill and ids, in scan order), 1 per
// tile in it; the first one scanned on a tie. On a map without a clear tile there is no region,
// and so every tile is marked.
export function mainRegionOf(grid: TerrainType[][]): Uint8Array {
  const label = Pathfinder.labelRegions(grid);
  const sizes: number[] = [];
  for (let k = 0; k < label.length; k++) {
    if (label[k] !== NO_REGION) sizes[label[k]] = (sizes[label[k]] ?? 0) + 1;
  }
  let best = NO_REGION;
  let bestSize = 0;
  for (let id = 0; id < sizes.length; id++) {
    if (sizes[id] > bestSize) {
      bestSize = sizes[id];
      best = id;
    }
  }
  const region = new Uint8Array(label.length);
  for (let k = 0; k < label.length; k++) if (label[k] === best) region[k] = 1;
  return region;
}

// True if the tile (x, y, floored) is on the map and in the region
export function inRegion(region: Uint8Array, x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= GRID_SIZE || ty >= GRID_SIZE) return false;
  return region[ty * GRID_SIZE + tx] === 1;
}

// The region's tile nearest to (x, y), in growing squares (the square's top row first); (x, y)
// itself when the region has no tile
export function nearestMainTile(region: Uint8Array, x: number, y: number): Position {
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (inRegion(region, x + dx, y + dy)) return { x: x + dx, y: y + dy };
      }
    }
  }
  return { x, y };
}

// Where an objective's places are: control points A and B, or one base per side (none for
// elimination)
export function objectivePlaces(
  region: Uint8Array,
  mode: Objective
): {
  points: { name: string; position: Position }[];
  bases: { faction: Faction; position: Position }[];
} {
  if (mode === 'control')
    return {
      points: [
        { name: 'A', position: nearestMainTile(region, CONTROL_POINT_A.x, CONTROL_POINT_A.y) },
        { name: 'B', position: nearestMainTile(region, CONTROL_POINT_B.x, CONTROL_POINT_B.y) },
      ],
      bases: [],
    };
  if (mode === 'base')
    return {
      points: [],
      bases: [
        { faction: Faction.FRIENDLY, position: nearestMainTile(region, WEST_BASE.x, WEST_BASE.y) },
        { faction: Faction.ENEMY, position: nearestMainTile(region, EAST_BASE.x, EAST_BASE.y) },
      ],
    };
  return { points: [], bases: [] };
}

// The row of hero `h` (0-based) of `heroCount` on its side's column: spread evenly over the height
export function heroSlotRow(h: number, heroCount: number): number {
  return Math.round(((h + 1) * GRID_SIZE) / (heroCount + 1));
}

// The columns a side's soldiers start in: [from, to)
export function soldierColumns(heroColumn: number): { from: number; to: number } {
  return {
    from: Math.max(1, heroColumn - SPAWN_AREA_HALF_WIDTH),
    to: Math.min(GRID_SIZE - 1, heroColumn + SPAWN_AREA_HALF_WIDTH + 1),
  };
}
