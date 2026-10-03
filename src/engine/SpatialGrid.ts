import { IUnit, Position, GRID_SIZE } from '../types/types';

const CELL_SIZE = 15;
const CELL_COUNT = 10; // ceil(150 / 15)

// Fine grid for the two per-unit, per-frame queries: counting allies and enemies in sight
// (courage) and finding the nearest enemy (D27). Both return exactly what a scan over the
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
  private cells = new Map<number, IUnit[]>();

  private fine: IUnit[][] = Array.from({ length: FINE_COUNT * FINE_COUNT }, () => []);
  // Units per fine cell and faction: [cell * 2 + faction]
  private fineCounts = new Int32Array(FINE_COUNT * FINE_COUNT * 2);
  // Set by nearestEnemy(): true when several units share the minimum distance
  private nearestTied: boolean = false;

  private fineIndex(x: number, y: number): number {
    return fineCell(y) * FINE_COUNT + fineCell(x);
  }

  private fineAdd(unit: IUnit, idx: number): void {
    this.fine[idx].push(unit);
    this.fineCounts[idx * 2 + unit.faction]++;
  }

  private fineRemove(unit: IUnit, idx: number): void {
    const cell = this.fine[idx];
    const i = cell.indexOf(unit);
    if (i === -1) return;
    cell[i] = cell[cell.length - 1];
    cell.pop();
    this.fineCounts[idx * 2 + unit.faction]--;
  }

  private key(cx: number, cy: number): number {
    return cy * CELL_COUNT + cx;
  }

  private toCell(v: number): number {
    return Math.min(CELL_COUNT - 1, Math.floor(v / CELL_SIZE));
  }

  insert(unit: IUnit): void {
    this.fineAdd(unit, this.fineIndex(unit.position.x, unit.position.y));
    const cx = this.toCell(unit.position.x);
    const cy = this.toCell(unit.position.y);
    const k = this.key(cx, cy);
    let cell = this.cells.get(k);
    if (!cell) {
      cell = [];
      this.cells.set(k, cell);
    }
    cell.push(unit);
  }

  remove(unit: IUnit): void {
    this.fineRemove(unit, this.fineIndex(unit.position.x, unit.position.y));
    const cx = this.toCell(unit.position.x);
    const cy = this.toCell(unit.position.y);
    const cell = this.cells.get(this.key(cx, cy));
    if (!cell) return;
    const idx = cell.indexOf(unit);
    if (idx === -1) return;
    cell[idx] = cell[cell.length - 1];
    cell.pop();
  }

  move(unit: IUnit, oldPos: Position): void {
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

    const oldCell = this.cells.get(this.key(ocx, ocy));
    if (oldCell) {
      const idx = oldCell.indexOf(unit);
      if (idx !== -1) {
        oldCell[idx] = oldCell[oldCell.length - 1];
        oldCell.pop();
      }
    }

    const nk = this.key(ncx, ncy);
    let newCell = this.cells.get(nk);
    if (!newCell) {
      newCell = [];
      this.cells.set(nk, newCell);
    }
    newCell.push(unit);
  }

  // Calls cb for every unit within radius — no array allocation.
  forEach(cx: number, cy: number, radius: number, cb: (unit: IUnit) => void): void {
    const r2 = radius * radius;
    const minCx = Math.max(0, Math.floor((cx - radius) / CELL_SIZE));
    const maxCx = Math.min(CELL_COUNT - 1, Math.floor((cx + radius) / CELL_SIZE));
    const minCy = Math.max(0, Math.floor((cy - radius) / CELL_SIZE));
    const maxCy = Math.min(CELL_COUNT - 1, Math.floor((cy + radius) / CELL_SIZE));

    for (let gy = minCy; gy <= maxCy; gy++) {
      for (let gx = minCx; gx <= maxCx; gx++) {
        const cell = this.cells.get(this.key(gx, gy));
        if (!cell) continue;
        for (const unit of cell) {
          const dx = unit.position.x - cx;
          const dy = unit.position.y - cy;
          if (dx * dx + dy * dy <= r2) cb(unit);
        }
      }
    }
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
      this.forEach(cx, cy, radius, (unit) => {
        if (unit.hp > 0) out[unit.faction]++;
      });
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

  // Nearest living unit not of `faction` within radius, searching fine cells ring by ring
  // outward and stopping once no closer unit can exist. When several units share the
  // minimum distance, wasNearestTied() is true: the scan order then decides, so the caller
  // reproduces the forEach() scan to pick the same unit as before.
  nearestEnemy(cx: number, cy: number, radius: number, faction: number): IUnit | null {
    const r2 = radius * radius;
    if (this.coarseCount(cx, cy, radius) <= SPARSE_LIMIT) {
      // The plain scan in forEach() order is the reference behavior itself, ties included
      let nearest: IUnit | null = null;
      let minD2 = Infinity;
      this.forEach(cx, cy, radius, (unit) => {
        if (unit.faction === faction || unit.hp <= 0) return;
        const dx = unit.position.x - cx;
        const dy = unit.position.y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < minD2) {
          minD2 = d2;
          nearest = unit;
        }
      });
      this.nearestTied = false;
      return nearest;
    }
    const fx0 = fineCell(cx);
    const fy0 = fineCell(cy);
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
          for (const unit of this.fine[fy * FINE_COUNT + fx]) {
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

  // Units in the coarse cells that forEach() would scan for this query
  private coarseCount(cx: number, cy: number, radius: number): number {
    const minCx = Math.max(0, Math.floor((cx - radius) / CELL_SIZE));
    const maxCx = Math.min(CELL_COUNT - 1, Math.floor((cx + radius) / CELL_SIZE));
    const minCy = Math.max(0, Math.floor((cy - radius) / CELL_SIZE));
    const maxCy = Math.min(CELL_COUNT - 1, Math.floor((cy + radius) / CELL_SIZE));
    let n = 0;
    for (let gy = minCy; gy <= maxCy; gy++) {
      for (let gx = minCx; gx <= maxCx; gx++) n += this.cells.get(this.key(gx, gy))?.length ?? 0;
    }
    return n;
  }

  wasNearestTied(): boolean {
    return this.nearestTied;
  }

  clear(): void {
    this.cells.clear();
    for (const cell of this.fine) cell.length = 0;
    this.fineCounts.fill(0);
  }
}
