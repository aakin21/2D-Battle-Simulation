import { TerrainType, Position, GRID_SIZE } from '../types/types';

interface AStarNode {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: AStarNode | null;
}

export class Pathfinder {
  static findPath(grid: TerrainType[][], start: Position, end: Position): Position[] {
    const sx = Math.floor(start.x);
    const sy = Math.floor(start.y);
    const ex = Math.floor(end.x);
    const ey = Math.floor(end.y);

    if (sx === ex && sy === ey) return [];
    // Start tile is not checked — unit is already standing there, so it's reachable
    // by definition. Checking it would cause A* to return [] when the unit is
    // adjacent to a mountain, permanently locking it in place.
    if (Pathfinder.isBlocked(grid, ex, ey)) return [];

    const key = (x: number, y: number): number => y * GRID_SIZE + x;
    const heuristic = (x: number, y: number): number => Math.abs(x - ex) + Math.abs(y - ey);

    const open: AStarNode[] = [];
    const closed = new Set<number>();
    const map = new Map<number, AStarNode>();

    const sh = heuristic(sx, sy);
    const startNode: AStarNode = { x: sx, y: sy, g: 0, h: sh, f: sh, parent: null };
    open.push(startNode);
    map.set(key(sx, sy), startNode);

    const DIRS = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const;

    while (open.length > 0) {
      // linear scan for min f — fast enough at current unit counts
      let li = 0;
      for (let i = 1; i < open.length; i++) {
        if (open[i].f < open[li].f) li = i;
      }
      const cur = open[li];
      // O(1) remove via swap-and-pop
      open[li] = open[open.length - 1];
      open.pop();

      const ck = key(cur.x, cur.y);
      if (closed.has(ck)) continue;
      closed.add(ck);

      if (cur.x === ex && cur.y === ey) {
        const raw = Pathfinder.rebuild(cur);
        return Pathfinder.smoothPath(grid, { x: sx, y: sy }, raw);
      }

      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        if (Pathfinder.isBlocked(grid, nx, ny)) continue;

        const nk = key(nx, ny);
        if (closed.has(nk)) continue;

        const ng = cur.g + 1;
        const existing = map.get(nk);
        if (!existing) {
          const nh = heuristic(nx, ny);
          const node: AStarNode = { x: nx, y: ny, g: ng, h: nh, f: ng + nh, parent: cur };
          open.push(node);
          map.set(nk, node);
        } else if (ng < existing.g) {
          existing.g = ng;
          existing.f = ng + existing.h;
          existing.parent = cur;
        }
      }
    }

    return []; // no path found
  }

  private static rebuild(node: AStarNode): Position[] {
    const path: Position[] = [];
    let cur: AStarNode | null = node;
    while (cur) {
      path.push({ x: cur.x, y: cur.y });
      cur = cur.parent;
    }
    path.reverse();
    path.shift(); // exclude start tile — unit is already there
    return path;
  }

  // Greedy forward scan — skip waypoints reachable in a straight line.
  // LOS uses tile centers (x+0.5, y+0.5) to match movement targets.
  private static smoothPath(grid: TerrainType[][], start: Position, path: Position[]): Position[] {
    if (path.length <= 1) return path;

    const result: Position[] = [];
    // Start from tile center — matches how movement targets are computed
    let fromX = Math.floor(start.x) + 0.5;
    let fromY = Math.floor(start.y) + 0.5;
    let i = 0;

    while (i < path.length) {
      // Find the furthest point reachable in a straight line from current position
      let furthest = i;
      for (let j = path.length - 1; j > i; j--) {
        if (Pathfinder.hasLOS(grid, fromX, fromY, path[j].x + 0.5, path[j].y + 0.5)) {
          furthest = j;
          break;
        }
      }
      result.push(path[furthest]);
      fromX = path[furthest].x + 0.5;
      fromY = path[furthest].y + 0.5;
      i = furthest + 1;
    }

    return result;
  }

  // True if the line from (ax,ay) to (bx,by) passes no blocked tiles.
  private static hasLOS(
    grid: TerrainType[][],
    ax: number,
    ay: number,
    bx: number,
    by: number
  ): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    // Step count: 2× the max tile-span so we never skip over a tile
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))) * 2 + 2;

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const xi = Math.floor(ax + dx * t);
      const yi = Math.floor(ay + dy * t);
      if (Pathfinder.isBlocked(grid, xi, yi)) return false;
    }

    return true;
  }

  // Blocked if the tile itself is mountain or any cardinal neighbor is.
  // 1-tile buffer keeps units from clipping into mountain edges.
  private static isBlocked(grid: TerrainType[][], x: number, y: number): boolean {
    if (grid[y]?.[x] === TerrainType.MOUNTAIN) return true;
    return (
      grid[y]?.[x + 1] === TerrainType.MOUNTAIN ||
      grid[y]?.[x - 1] === TerrainType.MOUNTAIN ||
      grid[y + 1]?.[x] === TerrainType.MOUNTAIN ||
      grid[y - 1]?.[x] === TerrainType.MOUNTAIN
    );
  }
}
