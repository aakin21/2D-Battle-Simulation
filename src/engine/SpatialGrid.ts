import { IUnit, Position, Faction, GRID_SIZE } from '../types/types';

const CELL_SIZE = 15;
const CELL_COUNT = Math.ceil(GRID_SIZE / CELL_SIZE); // 10

// Fine grid for the two per-unit, per-frame queries: counting allies and enemies in sight
// (courage) and finding the nearest enemy (D31). Both return exactly what a scan over the
// coarse grid would return; the coarse grid and forEach() are unchanged, so every other
// caller keeps its iteration order.
const FINE_SIZE = 4;
const FINE_COUNT = Math.ceil(GRID_SIZE / FINE_SIZE);
// Conservative margins: a cell is only counted as a whole when it is clearly inside the
// radius, and only skipped when clearly outside, so float rounding cannot change a result
const INSIDE_MARGIN = 1 - 1e-9;
const OUTSIDE_MARGIN = 1 + 1e-9;
// When the coarse cells around a query hold at most this many units, a plain scan is
// cheaper than walking the fine cells (sparse areas); both give the same result
const SPARSE_LIMIT = 48;
// Tile index (inRadiusInScanOrder): a query looks at the tiles this much beyond its radius, so
// float rounding in the distance test cannot leave out a unit forEach() would find
const TILE_MARGIN = 1e-6;
const TILE_COUNT = GRID_SIZE * GRID_SIZE;

// Tile of a position along one axis; off the map (or NaN) goes to an edge tile
function tileCoord(v: number): number {
  return v >= 0 ? Math.min(GRID_SIZE - 1, Math.floor(v)) : 0;
}

// Range of coarse cells that a query of this radius around v touches along one axis
function coarseMin(v: number, radius: number): number {
  return Math.max(0, Math.floor((v - radius) / CELL_SIZE));
}
function coarseMax(v: number, radius: number): number {
  return Math.min(CELL_COUNT - 1, Math.floor((v + radius) / CELL_SIZE));
}

// Removes the unit from the cell by moving the cell's last unit into its place. Returns
// false when the unit is not in the cell.
function swapRemove(cell: IUnit[], unit: IUnit): boolean {
  const i = cell.indexOf(unit);
  if (i === -1) return false;
  cell[i] = cell[cell.length - 1];
  cell.pop();
  return true;
}

function fineCell(v: number): number {
  return Math.max(0, Math.min(FINE_COUNT - 1, Math.floor(v / FINE_SIZE)));
}

// Bounds of a fine cell along one axis. Edge cells also hold anything clamped into them,
// so their outer side is unbounded.
function cellMin(f: number): number {
  return f === 0 ? -Infinity : f * FINE_SIZE;
}
function cellMax(f: number): number {
  return f === FINE_COUNT - 1 ? Infinity : (f + 1) * FINE_SIZE;
}

// Distance from v to the nearest and to the farthest point of [lo, hi]
function nearGap(v: number, lo: number, hi: number): number {
  return v < lo ? lo - v : v > hi ? v - hi : 0;
}
function farGap(v: number, lo: number, hi: number): number {
  return Math.max(Math.abs(v - lo), Math.abs(v - hi));
}

export class SpatialGrid {
  // Coarse cells by key (cy * CELL_COUNT + cx). Only a position off the map's low side (odd
  // input) gives a key outside the array; such cells are kept apart, as a map of keys would.
  private cells: IUnit[][] = Array.from({ length: CELL_COUNT * CELL_COUNT }, () => []);
  private offCells = new Map<number, IUnit[]>();

  private fine: IUnit[][] = Array.from({ length: FINE_COUNT * FINE_COUNT }, () => []);
  // Units per fine cell and faction: [cell * 2 + faction]
  private fineCounts = new Int32Array(FINE_COUNT * FINE_COUNT * 2);
  // Set by nearestEnemy(): true when several units share the minimum distance
  private nearestTied: boolean = false;

  // Tile index for inRadiusInScanOrder(), rebuilt after any unit was added, removed or moved:
  // the units sorted by tile (tile t holds entries tileStart[t] .. tileStart[t + 1] - 1), each
  // with its position, its coarse cell and its rank in the order forEach() visits units
  private tileIndexValid = false;
  private tileStart = new Int32Array(TILE_COUNT + 1);
  private tileFill = new Int32Array(TILE_COUNT);
  private tileUnits: IUnit[] = [];
  private tileCellX = new Int32Array(0);
  private tileCellY = new Int32Array(0);
  private tileX = new Float64Array(0);
  private tileY = new Float64Array(0);
  private tileRank = new Int32Array(0);
  private found: IUnit[] = [];
  private foundRank = new Int32Array(0);

  private fineIndex(x: number, y: number): number {
    return fineCell(y) * FINE_COUNT + fineCell(x);
  }

  private fineAdd(unit: IUnit, idx: number): void {
    this.fine[idx].push(unit);
    this.fineCounts[idx * 2 + unit.faction]++;
  }

  private fineRemove(unit: IUnit, idx: number): void {
    if (!swapRemove(this.fine[idx], unit)) return;
    this.fineCounts[idx * 2 + unit.faction]--;
  }

  private key(cx: number, cy: number): number {
    return cy * CELL_COUNT + cx;
  }

  private cell(key: number): IUnit[] | undefined {
    return key >= 0 && key < CELL_COUNT * CELL_COUNT ? this.cells[key] : this.offCells.get(key);
  }

  private cellOrNew(key: number): IUnit[] {
    let cell = this.cell(key);
    if (!cell) {
      cell = [];
      this.offCells.set(key, cell);
    }
    return cell;
  }

  private toCell(v: number): number {
    return Math.min(CELL_COUNT - 1, Math.floor(v / CELL_SIZE));
  }

  insert(unit: IUnit): void {
    this.tileIndexValid = false;
    this.fineAdd(unit, this.fineIndex(unit.position.x, unit.position.y));
    const cx = this.toCell(unit.position.x);
    const cy = this.toCell(unit.position.y);
    const k = this.key(cx, cy);
    this.cellOrNew(k).push(unit);
  }

  remove(unit: IUnit): void {
    this.tileIndexValid = false;
    this.fineRemove(unit, this.fineIndex(unit.position.x, unit.position.y));
    const cx = this.toCell(unit.position.x);
    const cy = this.toCell(unit.position.y);
    const cell = this.cell(this.key(cx, cy));
    if (cell) swapRemove(cell, unit);
  }

  move(unit: IUnit, oldPos: Position): void {
    this.tileIndexValid = false;
    const oldFine = this.fineIndex(oldPos.x, oldPos.y);
    const newFine = this.fineIndex(unit.position.x, unit.position.y);
    if (oldFine !== newFine) {
      this.fineRemove(unit, oldFine);
      this.fineAdd(unit, newFine);
    }

    const ocx = this.toCell(oldPos.x);
    const ocy = this.toCell(oldPos.y);
    const ncx = this.toCell(unit.position.x);
    const ncy = this.toCell(unit.position.y);
    if (ocx === ncx && ocy === ncy) return;

    const oldCell = this.cell(this.key(ocx, ocy));
    if (oldCell) swapRemove(oldCell, unit);

    const nk = this.key(ncx, ncy);
    this.cellOrNew(nk).push(unit);
  }

  // Calls cb for every unit within radius — no array allocation.
  forEach(cx: number, cy: number, radius: number, cb: (unit: IUnit) => void): void {
    const r2 = radius * radius;
    const minCx = coarseMin(cx, radius);
    const maxCx = coarseMax(cx, radius);
    const minCy = coarseMin(cy, radius);
    const maxCy = coarseMax(cy, radius);

    for (let gy = minCy; gy <= maxCy; gy++) {
      for (let gx = minCx; gx <= maxCx; gx++) {
        const cell = this.cell(this.key(gx, gy));
        if (!cell) continue;
        for (const unit of cell) {
          const dx = unit.position.x - cx;
          const dy = unit.position.y - cy;
          if (dx * dx + dy * dy <= r2) cb(unit);
        }
      }
    }
  }

  // The units forEach() would visit, in the same order, as a list that the next call reuses.
  // Separation (D53) asks this for every unit with a radius under a tile while no unit moves:
  // forEach() scans whole 15-tile cells, this looks at the few tiles around the query only.
  inRadiusInScanOrder(cx: number, cy: number, radius: number): readonly IUnit[] {
    if (!this.tileIndexValid) this.buildTileIndex();
    const found = this.found;
    const foundRank = this.foundRank;
    let n = 0;
    const r2 = radius * radius;
    // The coarse cells forEach() scans: a unit listed in another cell is not visited
    const minCx = coarseMin(cx, radius);
    const maxCx = coarseMax(cx, radius);
    const minCy = coarseMin(cy, radius);
    const maxCy = coarseMax(cy, radius);
    const tx0 = tileCoord(cx - radius - TILE_MARGIN);
    const tx1 = tileCoord(cx + radius + TILE_MARGIN);
    const ty0 = tileCoord(cy - radius - TILE_MARGIN);
    const ty1 = tileCoord(cy + radius + TILE_MARGIN);
    const start = this.tileStart;
    const { tileX, tileY, tileCellX, tileCellY, tileRank, tileUnits } = this;
    for (let ty = ty0; ty <= ty1; ty++) {
      const row = ty * GRID_SIZE;
      for (let i = start[row + tx0], end = start[row + tx1 + 1]; i < end; i++) {
        const gx = tileCellX[i];
        const gy = tileCellY[i];
        if (gx < minCx || gx > maxCx || gy < minCy || gy > maxCy) continue;
        const dx = tileX[i] - cx;
        const dy = tileY[i] - cy;
        if (dx * dx + dy * dy > r2) continue;
        // Insertion by rank: a query finds a handful of units
        const r = tileRank[i];
        let j = n++;
        while (j > 0 && foundRank[j - 1] > r) {
          found[j] = found[j - 1];
          foundRank[j] = foundRank[j - 1];
          j--;
        }
        found[j] = tileUnits[i];
        foundRank[j] = r;
      }
    }
    found.length = n;
    return found;
  }

  // Lists every unit forEach() can reach under the tile it stands on, in forEach() order:
  // coarse cell by cell in key order (the order forEach() scans the cells of any query), then in
  // the cell's own order. A counting sort by tile keeps that order within each tile. Positions
  // are copied: the index is only used while no unit moves.
  private buildTileIndex(): void {
    const start = this.tileStart;
    start.fill(0);
    let n = 0;
    for (let key = 0; key < CELL_COUNT * CELL_COUNT; key++) {
      const cell = this.cell(key);
      if (!cell) continue;
      for (const unit of cell) {
        start[tileCoord(unit.position.y) * GRID_SIZE + tileCoord(unit.position.x) + 1]++;
        n++;
      }
    }
    for (let t = 0; t < TILE_COUNT; t++) start[t + 1] += start[t];
    if (this.tileRank.length < n) {
      const size = n * 2;
      this.tileRank = new Int32Array(size);
      this.tileCellX = new Int32Array(size);
      this.tileCellY = new Int32Array(size);
      this.tileX = new Float64Array(size);
      this.tileY = new Float64Array(size);
      this.foundRank = new Int32Array(size);
    }
    const fill = this.tileFill;
    fill.set(start.subarray(0, TILE_COUNT));
    let rank = 0;
    for (let key = 0; key < CELL_COUNT * CELL_COUNT; key++) {
      const cell = this.cell(key);
      if (!cell) continue;
      // Cells by key, as forEach() reads a key (cy * CELL_COUNT + cx)
      const gx = key % CELL_COUNT;
      const gy = (key - gx) / CELL_COUNT;
      for (const unit of cell) {
        const { x, y } = unit.position;
        const i = fill[tileCoord(y) * GRID_SIZE + tileCoord(x)]++;
        this.tileUnits[i] = unit;
        this.tileCellX[i] = gx;
        this.tileCellY[i] = gy;
        this.tileX[i] = x;
        this.tileY[i] = y;
        this.tileRank[i] = rank++;
      }
    }
    this.tileIndexValid = true;
  }

  query(cx: number, cy: number, radius: number): IUnit[] {
    const result: IUnit[] = [];
    this.forEach(cx, cy, radius, (u) => result.push(u));
    return result;
  }

  // Counts living units within radius per faction into out[faction]. Same result as
  // counting inside forEach(), but cells entirely inside the circle are added from their
  // counters; only cells on the circle's edge are checked unit by unit.
  countByFaction(cx: number, cy: number, radius: number, out: Int32Array): void {
    out[0] = 0;
    out[1] = 0;
    const r2 = radius * radius;
    if (this.coarseCount(cx, cy, radius) <= SPARSE_LIMIT) {
      // The forEach() scan, written out (no closure per query)
      const minCx = coarseMin(cx, radius);
      const maxCx = coarseMax(cx, radius);
      const minCy = coarseMin(cy, radius);
      const maxCy = coarseMax(cy, radius);
      for (let gy = minCy; gy <= maxCy; gy++) {
        for (let gx = minCx; gx <= maxCx; gx++) {
          const cell = this.cell(this.key(gx, gy));
          if (!cell) continue;
          for (const unit of cell) {
            const dx = unit.position.x - cx;
            const dy = unit.position.y - cy;
            if (dx * dx + dy * dy <= r2 && unit.hp > 0) out[unit.faction]++;
          }
        }
      }
      return;
    }
    const inside2 = r2 * INSIDE_MARGIN;
    const outside2 = r2 * OUTSIDE_MARGIN;
    const minFx = fineCell(cx - radius);
    const maxFx = fineCell(cx + radius);
    const minFy = fineCell(cy - radius);
    const maxFy = fineCell(cy + radius);

    for (let fy = minFy; fy <= maxFy; fy++) {
      const y0 = cellMin(fy);
      const y1 = cellMax(fy);
      const nearY = nearGap(cy, y0, y1);
      const farY = farGap(cy, y0, y1);
      for (let fx = minFx; fx <= maxFx; fx++) {
        const x0 = cellMin(fx);
        const x1 = cellMax(fx);
        const nearX = nearGap(cx, x0, x1);
        if (nearX * nearX + nearY * nearY > outside2) continue;

        const idx = fy * FINE_COUNT + fx;
        const farX = farGap(cx, x0, x1);
        if (farX * farX + farY * farY <= inside2) {
          // Living units only: dead units are removed in the same frame they die
          out[0] += this.fineCounts[idx * 2];
          out[1] += this.fineCounts[idx * 2 + 1];
          continue;
        }
        for (const unit of this.fine[idx]) {
          if (unit.hp <= 0) continue;
          const dx = unit.position.x - cx;
          const dy = unit.position.y - cy;
          if (dx * dx + dy * dy <= r2) out[unit.faction]++;
        }
      }
    }
  }

  // Whether a living unit of another faction is within radius: the same answer as
  // nearestEnemy() !== null, but it stops at the first one (separation asks it per unit, D53)
  hasEnemy(cx: number, cy: number, radius: number, faction: Faction): boolean {
    const r2 = radius * radius;
    const inside2 = r2 * INSIDE_MARGIN;
    const outside2 = r2 * OUTSIDE_MARGIN;
    // The side whose units are enemies here (-1: any faction number but the two sides)
    const otherSide = faction === 0 ? 1 : faction === 1 ? 0 : -1;
    const minFx = fineCell(cx - radius);
    const maxFx = fineCell(cx + radius);
    const minFy = fineCell(cy - radius);
    const maxFy = fineCell(cy + radius);
    for (let fy = minFy; fy <= maxFy; fy++) {
      const y0 = cellMin(fy);
      const y1 = cellMax(fy);
      const nearY = nearGap(cy, y0, y1);
      const farY = farGap(cy, y0, y1);
      for (let fx = minFx; fx <= maxFx; fx++) {
        const idx = fy * FINE_COUNT + fx;
        if (otherSide >= 0 && this.fineCounts[idx * 2 + otherSide] === 0) continue;
        const x0 = cellMin(fx);
        const x1 = cellMax(fx);
        const nearX = nearGap(cx, x0, x1);
        if (nearX * nearX + nearY * nearY > outside2) continue;
        const farX = farGap(cx, x0, x1);
        // Living units only: dead units are removed in the same frame they die
        if (otherSide >= 0 && farX * farX + farY * farY <= inside2) return true;
        for (const unit of this.fine[idx]) {
          if (unit.faction === faction || unit.hp <= 0) continue;
          const dx = unit.position.x - cx;
          const dy = unit.position.y - cy;
          if (dx * dx + dy * dy <= r2) return true;
        }
      }
    }
    return false;
  }

  // Nearest living unit not of `faction` within radius, searching fine cells ring by ring
  // outward and stopping once no closer unit can exist. When several units share the
  // minimum distance, wasNearestTied() is true: the scan order then decides, so the caller
  // reproduces the forEach() scan to pick the same unit as before.
  nearestEnemy(cx: number, cy: number, radius: number, faction: Faction): IUnit | null {
    const r2 = radius * radius;
    if (this.coarseCount(cx, cy, radius) <= SPARSE_LIMIT) {
      this.nearestTied = false;
      return this.scanNearestEnemy(cx, cy, radius, faction);
    }
    const fx0 = fineCell(cx);
    const fy0 = fineCell(cy);
    // The side whose units are enemies here (-1: any faction number but the two sides)
    const otherSide = faction === 0 ? 1 : faction === 1 ? 0 : -1;
    const maxRing = Math.ceil(radius / FINE_SIZE) + 1;
    let best: IUnit | null = null;
    let bestD2 = Infinity;
    let tied = false;

    for (let k = 0; k <= maxRing; k++) {
      // Every cell of ring k is at least (k - 1) cells away from the query point
      if (k >= 2) {
        const lower = (k - 1) * FINE_SIZE;
        const lower2 = lower * lower;
        if (lower2 > bestD2 || lower2 > r2 * OUTSIDE_MARGIN) break;
      }
      const ys = Math.max(0, fy0 - k);
      const ye = Math.min(FINE_COUNT - 1, fy0 + k);
      for (let fy = ys; fy <= ye; fy++) {
        const onEdgeRow = fy === fy0 - k || fy === fy0 + k;
        const step = onEdgeRow ? 1 : 2 * k;
        for (let fx = fx0 - k; fx <= fx0 + k; fx += Math.max(1, step)) {
          if (fx < 0 || fx >= FINE_COUNT) continue;
          const idx = fy * FINE_COUNT + fx;
          // A cell with no unit of another side has nothing to find
          if (otherSide >= 0 && this.fineCounts[idx * 2 + otherSide] === 0) continue;
          for (const unit of this.fine[idx]) {
            if (unit.faction === faction || unit.hp <= 0) continue;
            const dx = unit.position.x - cx;
            const dy = unit.position.y - cy;
            const d2 = dx * dx + dy * dy;
            if (d2 > r2) continue;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = unit;
              tied = false;
            } else if (d2 === bestD2) {
              tied = true;
            }
          }
        }
      }
    }
    this.nearestTied = tied;
    return best;
  }

  // The plain scan in forEach() order, the reference result: on a tie, the unit scanned first
  // (written out, no closure per query)
  scanNearestEnemy(cx: number, cy: number, radius: number, faction: Faction): IUnit | null {
    let nearest: IUnit | null = null;
    let minD2 = Infinity;
    const r2 = radius * radius;
    const minCx = coarseMin(cx, radius);
    const maxCx = coarseMax(cx, radius);
    const minCy = coarseMin(cy, radius);
    const maxCy = coarseMax(cy, radius);
    for (let gy = minCy; gy <= maxCy; gy++) {
      for (let gx = minCx; gx <= maxCx; gx++) {
        const cell = this.cell(this.key(gx, gy));
        if (!cell) continue;
        for (const unit of cell) {
          const dx = unit.position.x - cx;
          const dy = unit.position.y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2 || unit.faction === faction || unit.hp <= 0) continue;
          if (d2 < minD2) {
            minD2 = d2;
            nearest = unit;
          }
        }
      }
    }
    return nearest;
  }

  // Units in the coarse cells that forEach() would scan for this query
  private coarseCount(cx: number, cy: number, radius: number): number {
    const minCx = coarseMin(cx, radius);
    const maxCx = coarseMax(cx, radius);
    const minCy = coarseMin(cy, radius);
    const maxCy = coarseMax(cy, radius);
    let n = 0;
    for (let gy = minCy; gy <= maxCy; gy++) {
      for (let gx = minCx; gx <= maxCx; gx++) n += this.cell(this.key(gx, gy))?.length ?? 0;
    }
    return n;
  }

  wasNearestTied(): boolean {
    return this.nearestTied;
  }

  clear(): void {
    this.tileIndexValid = false;
    for (const cell of this.cells) cell.length = 0;
    this.offCells.clear();
    for (const cell of this.fine) cell.length = 0;
    this.fineCounts.fill(0);
  }
}
