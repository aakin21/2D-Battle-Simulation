import { IUnit, Position } from '../types/types';

const CELL_SIZE = 15;
const CELL_COUNT = 10; // ceil(150 / 15)

export class SpatialGrid {
  private cells = new Map<number, IUnit[]>();

  private key(cx: number, cy: number): number {
    return cy * CELL_COUNT + cx;
  }

  private toCell(v: number): number {
    return Math.min(CELL_COUNT - 1, Math.floor(v / CELL_SIZE));
  }

  insert(unit: IUnit): void {
    const cx = this.toCell(unit.position.x);
    const cy = this.toCell(unit.position.y);
    const k = this.key(cx, cy);
    let cell = this.cells.get(k);
    if (!cell) { cell = []; this.cells.set(k, cell); }
    cell.push(unit);
  }

  remove(unit: IUnit): void {
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
    const ocx = this.toCell(oldPos.x);
    const ocy = this.toCell(oldPos.y);
    const ncx = this.toCell(unit.position.x);
    const ncy = this.toCell(unit.position.y);
    if (ocx === ncx && ocy === ncy) return;

    const oldCell = this.cells.get(this.key(ocx, ocy));
    if (oldCell) {
      const idx = oldCell.indexOf(unit);
      if (idx !== -1) { oldCell[idx] = oldCell[oldCell.length - 1]; oldCell.pop(); }
    }

    const nk = this.key(ncx, ncy);
    let newCell = this.cells.get(nk);
    if (!newCell) { newCell = []; this.cells.set(nk, newCell); }
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

  clear(): void {
    this.cells.clear();
  }
}
