import { StateManager } from '../state/StateManager';
import { IUnit, TerrainType, GRID_SIZE, UnitType } from '../types/types';
import { canStep } from './UnitHelpers';
import { SEPARATION_DEAD_ZONE, SEPARATION_RADIUS, SEPARATION_SPEED } from './Rules';

// Battle mode: units take up room. Every unit is pushed away from the units closer than
// SEPARATION_RADIUS, at most SEPARATION_SPEED tiles/s, so a crowd spreads out instead of
// standing on one tile. Units push and give way but never block each other. Without it a
// bigger army stood on a few tiles and up to 247 of its soldiers hit one enemy at once: 700
// soldiers beat 500 losing only 79 (CASES 14.x; melee should lose about as many as it kills,
// Lanchester's linear law). Never into a mountain or a tile next to one (the pathfinder's
// blocked tiles), and no random numbers: units on the very same spot part in a direction
// worked out from their ids.

// The pushes of a frame, reused: unit i moves by (moveX[i], moveY[i])
const moved: IUnit[] = [];
const moveX: number[] = [];
const moveY: number[] = [];

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
  moved.length = 0;
  moveX.length = 0;
  moveY.length = 0;
  for (const unit of units) {
    if (unit.hp <= 0) continue;
    let px = 0;
    let py = 0;
    // The neighbours in the spatial grid's scan order, so the pushes add up in the same order
    const near = sm.unitsInRadiusInScanOrder(unit.position.x, unit.position.y, SEPARATION_RADIUS);
    for (const other of near) {
      if (other === unit || other.hp <= 0) continue;
      // A hero is never pushed by its own side: its soldiers make way. Pushed by its crowd of
      // followers (50 within 1.5 tiles), a hero could not walk at all, whatever its order.
      const ownHero = other.faction === unit.faction;
      if (ownHero && unit.unitType === UnitType.HERO) continue;
      const dx = unit.position.x - other.position.x;
      const dy = unit.position.y - other.position.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      if (d2 < 1e-12) {
        const a = partingAngle(unit.id, other.id);
        px += Math.cos(a);
        py += Math.sin(a);
        continue;
      }
      const d = Math.sqrt(d2);
      // 1 on top, 0 at the radius; twice as strong from one's own hero, so the way opens fast
      const yieldTo = ownHero && other.unitType === UnitType.HERO ? 2 : 1;
      const weight = (yieldTo * (SEPARATION_RADIUS - d)) / SEPARATION_RADIUS;
      px += (dx / d) * weight;
      py += (dy / d) * weight;
    }
    const push = Math.hypot(px, py);
    // A slight overlap is left alone, so units that have settled do not keep shuffling
    if (push < SEPARATION_DEAD_ZONE) continue;
    // Full speed once the overlap adds up to one unit on top; slower for a slight overlap
    const step = Math.min(1, push) * maxStep;
    moved.push(unit);
    moveX.push((px / push) * step);
    moveY.push((py / push) * step);
  }

  for (let i = 0; i < moved.length; i++) {
    const unit = moved[i];
    const ox = unit.position.x;
    const oy = unit.position.y;
    let nx = clamp(ox + moveX[i]);
    let ny = clamp(oy + moveY[i]);
    // Slide along an obstacle: keep the part of the push that stays on open ground
    if (!canStep(grid, ox, oy, nx, ny)) {
      if (canStep(grid, ox, oy, nx, oy)) ny = oy;
      else if (canStep(grid, ox, oy, ox, ny)) nx = ox;
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

// Two units on the very same spot part in opposite directions, the same ones every run
function partingAngle(id: string, other: string): number {
  const [a, b] = id < other ? [id, other] : [other, id];
  let h = 2166136261;
  for (const ch of `${a}|${b}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const angle = ((h >>> 0) / 2 ** 32) * 2 * Math.PI;
  return id < other ? angle : angle + Math.PI;
}
