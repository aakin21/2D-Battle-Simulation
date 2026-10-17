import { StateManager } from '../state/StateManager';
import { IUnit, TerrainType, GRID_SIZE, UnitType } from '../types/types';
import { Pathfinder } from './Pathfinder';
import { SEPARATION_DEAD_ZONE, SEPARATION_RADIUS, SEPARATION_SPEED } from './Rules';

// Battle mode: units take up room. Every unit is pushed away from the units closer than
// SEPARATION_RADIUS, at most SEPARATION_SPEED tiles/s, so a crowd spreads out instead of
// standing on one tile. Units push and give way but never block each other. Without it a
// bigger army stood on a few tiles and up to 247 of its soldiers hit one enemy at once: 700
// soldiers beat 500 losing only 79 (CASES 14.x; melee should lose about as many as it kills,
// Lanchester's linear law). Never into a mountain or a tile next to one (the pathfinder's
// blocked tiles), and no random numbers: units on the very same spot part in a direction
// worked out from their ids.

export function separateUnits(
  sm: StateManager,
  units: IUnit[],
  deltaTime: number,
  grid: TerrainType[][]
): void {
  const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
  const maxStep = SEPARATION_SPEED * deltaTime;
  // Pushes are worked out from the positions before any unit moves, so the order of the unit
  // list does not matter
  const moves: Array<[IUnit, number, number]> = [];
  for (const unit of units) {
    if (unit.hp <= 0) continue;
    let px = 0;
    let py = 0;
    sm.forEachInRadius(unit.position.x, unit.position.y, SEPARATION_RADIUS, (other) => {
      if (other === unit || other.hp <= 0) return;
      // A hero is never pushed by its own side: its soldiers make way. Pushed by its crowd of
      // followers (50 within 1.5 tiles), a hero could not walk at all, whatever its order.
      const ownHero = other.faction === unit.faction;
      if (ownHero && unit.unitType === UnitType.HERO) return;
      const dx = unit.position.x - other.position.x;
      const dy = unit.position.y - other.position.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) return;
      if (d2 < 1e-12) {
        const a = partingAngle(unit.id, other.id);
        px += Math.cos(a);
        py += Math.sin(a);
        return;
      }
      const d = Math.sqrt(d2);
      // 1 on top, 0 at the radius; twice as strong from one's own hero, so the way opens fast
      const yieldTo = ownHero && other.unitType === UnitType.HERO ? 2 : 1;
      const weight = (yieldTo * (SEPARATION_RADIUS - d)) / SEPARATION_RADIUS;
      px += (dx / d) * weight;
      py += (dy / d) * weight;
    });
    const push = Math.hypot(px, py);
    // A slight overlap is left alone, so units that have settled do not keep shuffling
    if (push < SEPARATION_DEAD_ZONE) continue;
    // Full speed once the overlap adds up to one unit on top; slower for a slight overlap
    const step = Math.min(1, push) * maxStep;
    moves.push([unit, (px / push) * step, (py / push) * step]);
  }

  for (const [unit, mx, my] of moves) {
    const ox = unit.position.x;
    const oy = unit.position.y;
    let nx = clamp(ox + mx);
    let ny = clamp(oy + my);
    // Slide along an obstacle: keep the part of the push that stays on open ground
    if (!canStand(grid, ox, oy, nx, ny)) {
      if (canStand(grid, ox, oy, nx, oy)) ny = oy;
      else if (canStand(grid, ox, oy, ox, ny)) nx = ox;
      else continue;
    }
    unit.position.x = nx;
    unit.position.y = ny;
    sm.syncPosition(unit, ox, oy);
  }
}

function clamp(v: number): number {
  return Math.max(0.5, Math.min(GRID_SIZE - 0.5, v));
}

// A push may keep a unit on its own tile, or move it onto a tile the pathfinder can use in the
// same walkable region. Regions join through tile edges, while a push can cross the corner where
// two mountain buffers meet: that put units into pockets no path reaches, and whole armies then
// stood in front of them (CASES 14.x).
function canStand(grid: TerrainType[][], ox: number, oy: number, nx: number, ny: number): boolean {
  const fx = Math.floor(ox);
  const fy = Math.floor(oy);
  const tx = Math.floor(nx);
  const ty = Math.floor(ny);
  if (tx === fx && ty === fy) return true;
  if (Pathfinder.isBlocked(grid, tx, ty)) return false;
  return Pathfinder.sameRegion(grid, fx, fy, tx, ty);
}

// Two units on the very same spot part in opposite directions, the same ones every run
function partingAngle(id: string, other: string): number {
  const [a, b] = id < other ? [id, other] : [other, id];
  let h = 2166136261;
  for (const ch of `${a}|${b}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const angle = ((h >>> 0) / 2 ** 32) * 2 * Math.PI;
  return id < other ? angle : angle + Math.PI;
}
