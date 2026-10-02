import { Camera, UnitType, UNIT_COLORS } from '../../types/types';
import { Pool } from './Pool';
import type { DeathEvent } from './EffectsManager';

// Death animation: the unit "falls" (its square tips over to a random angle and
// darkens), the body lies for a while, then fades out. Times are in simulation seconds.
const FALL_TIME = 0.4;
const CORPSE_LIFE = 5;
const FADE_TIME = 1.5; // last part of CORPSE_LIFE spent fading out

// Final tilt is 20°–70° to either side, so bodies never look upright
const MIN_TILT = (20 * Math.PI) / 180;
const MAX_TILT = (70 * Math.PI) / 180;

// Enough for mass casualties in stress mode; extra deaths beyond this are not drawn
const MAX_CORPSES = 1500;

const DARK_COLORS: Record<string, string> = {
  WARRIOR: '#7a6600',
  HERO: '#7a0000',
  BERSERKER: '#1f3270',
};

interface Corpse {
  x: number;
  y: number;
  unitType: UnitType;
  age: number;
  tilt: number; // final angle in radians
  // cos/sin of the final angle, cached so lying corpses need no trig per frame
  cos: number;
  sin: number;
}

// Adds a square with half-side `half` centered at (cx, cy), rotated by (cos, sin), to the path
function addRotatedSquare(
  path: CanvasPath,
  cx: number,
  cy: number,
  half: number,
  cos: number,
  sin: number
): void {
  const ax = half * (cos - sin);
  const ay = half * (sin + cos);
  const bx = half * (cos + sin);
  const by = half * (sin - cos);
  path.moveTo(cx - ax, cy - ay);
  path.lineTo(cx + bx, cy + by);
  path.lineTo(cx + ax, cy + ay);
  path.lineTo(cx - bx, cy - by);
  path.closePath();
}

export class Corpses {
  private pool = new Pool<Corpse>(MAX_CORPSES, () => ({
    x: 0,
    y: 0,
    unitType: UnitType.WARRIOR,
    age: 0,
    tilt: 0,
    cos: 1,
    sin: 0,
  }));

  spawn(e: DeathEvent): void {
    const c = this.pool.spawn();
    if (!c) return;
    c.x = e.x;
    c.y = e.y;
    c.unitType = e.unitType;
    c.age = 0;
    const side = Math.random() < 0.5 ? -1 : 1;
    c.tilt = side * (MIN_TILT + Math.random() * (MAX_TILT - MIN_TILT));
    c.cos = Math.cos(c.tilt);
    c.sin = Math.sin(c.tilt);
  }

  update(dt: number): void {
    if (dt === 0) return;
    this.pool.update((c) => {
      c.age += dt;
      return c.age < CORPSE_LIFE;
    });
  }

  clear(): void {
    this.pool.clear();
  }

  get size(): number {
    return this.pool.size;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number): void {
    if (this.pool.size === 0) return;
    const { x: camX, y: camY, zoom } = camera;
    // Same square size as living units in Renderer.drawUnits
    const size = Math.max(3, zoom * 2);
    const half = size / 2;
    // A rotated square reaches up to half·√2 from its center
    const reach = half * Math.SQRT2;
    const fadeStart = CORPSE_LIFE - FADE_TIME;

    // Most corpses are lying and fully opaque: collect them into one path per unit
    // type and fill once, instead of thousands of separate fills/globalAlpha changes.
    // Only falling and fading corpses (a small minority) are drawn one by one.
    const lying: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];

    this.pool.forEach((c) => {
      const cx = (c.x - camX) * zoom;
      const cy = (c.y - camY) * zoom;
      if (cx + reach < 0 || cx - reach > width || cy + reach < 0 || cy - reach > height) return;

      if (c.age >= FALL_TIME && c.age < fadeStart) {
        addRotatedSquare(lying[c.unitType], cx, cy, half, c.cos, c.sin);
        return;
      }

      const name = UnitType[c.unitType];
      if (c.age < FALL_TIME) {
        // Falling: square tips over toward its final angle, unit color fades to dark
        const t = c.age / FALL_TIME;
        const a = c.tilt * t;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        ctx.globalAlpha = 1;
        ctx.fillStyle = DARK_COLORS[name];
        ctx.beginPath();
        addRotatedSquare(ctx, cx, cy, half, cos, sin);
        ctx.fill();
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = UNIT_COLORS[name];
        ctx.fill();
      } else {
        ctx.globalAlpha = 1 - (c.age - fadeStart) / FADE_TIME;
        ctx.fillStyle = DARK_COLORS[name];
        ctx.beginPath();
        addRotatedSquare(ctx, cx, cy, half, c.cos, c.sin);
        ctx.fill();
      }
    });
    ctx.globalAlpha = 1;

    for (let t = 0; t < lying.length; t++) {
      ctx.fillStyle = DARK_COLORS[UnitType[t]];
      ctx.fill(lying[t]);
    }
  }
}
