import { Camera, UnitType, UNIT_COLORS } from '../../types/types';
import { Pool } from './Pool';
import type { DeathEvent } from './EffectsManager';
import {
  CORPSE_SPRITE_CANVAS,
  CORPSE_SPRITE_SIDE,
  CORPSE_TILTS,
  makeCorpseSprites,
} from './sprites';

// Death animation: the unit "falls" (its square tips over to a random angle and
// darkens), the body lies for a while, then fades out. Times are in simulation seconds.
const FALL_TIME = 0.4;
const CORPSE_LIFE = 5;
const FADE_TIME = 1.5; // last part of CORPSE_LIFE spent fading out

// Enough for mass casualties in stress mode; extra deaths beyond this are not drawn
const MAX_CORPSES = 1500;

const DARK_COLORS: Record<string, string> = {
  WARRIOR: '#7a6600',
  HERO: '#3d0000', // darker than blood pools so the hero's body stays visible
  BERSERKER: '#1f3270',
};

interface Corpse {
  x: number;
  y: number;
  unitType: UnitType;
  age: number;
  tilt: number; // index into CORPSE_TILTS
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
  }));
  // [unitType][tiltIndex], built by prepare() (needs a DOM)
  private sprites: HTMLCanvasElement[][] | null = null;

  spawn(e: DeathEvent): void {
    const c = this.pool.spawn();
    if (!c) return;
    c.x = e.x;
    c.y = e.y;
    c.unitType = e.unitType;
    c.age = 0;
    c.tilt = Math.floor(Math.random() * CORPSE_TILTS.length);
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

  // Builds the sprites. Called at startup so the first death causes no hitch.
  // With a target context, each sprite is drawn once (tiny) to upload it to the GPU.
  prepare(warmTarget?: CanvasRenderingContext2D): void {
    if (this.sprites) return;
    this.sprites = makeCorpseSprites([
      DARK_COLORS[UnitType[UnitType.WARRIOR]],
      DARK_COLORS[UnitType[UnitType.HERO]],
      DARK_COLORS[UnitType[UnitType.BERSERKER]],
    ]);
    if (!warmTarget) return;
    for (const row of this.sprites) for (const sp of row) warmTarget.drawImage(sp, 0, 0, 4, 4);
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number): void {
    if (this.pool.size === 0) return;
    this.prepare();
    const sprites = this.sprites!;
    const { x: camX, y: camY, zoom } = camera;
    // Same square size as living units in Renderer.drawUnits
    const size = Math.max(3, zoom * 2);
    const half = size / 2;
    // On-screen size of the sprite canvas (which has padding for the rotation)
    const d = (size * CORPSE_SPRITE_CANVAS) / CORPSE_SPRITE_SIDE;
    const reach = d / 2;
    const fadeStart = CORPSE_LIFE - FADE_TIME;

    // Sprites are downscaled; smoothing keeps their tilted edges clean
    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;

    this.pool.forEach((c) => {
      const cx = (c.x - camX) * zoom;
      const cy = (c.y - camY) * zoom;
      if (cx + reach < 0 || cx - reach > width || cy + reach < 0 || cy - reach > height) return;

      if (c.age >= FALL_TIME) {
        // Lying (most corpses): a pre-rendered sprite, faded near the end of its life
        ctx.globalAlpha = c.age < fadeStart ? 1 : 1 - (c.age - fadeStart) / FADE_TIME;
        ctx.drawImage(sprites[c.unitType][c.tilt], cx - reach, cy - reach, d, d);
        return;
      }

      // Falling (few at a time): square tips over toward its final angle and the
      // unit color fades to dark. The angle is animated, so it is drawn as a path.
      const name = UnitType[c.unitType];
      const t = c.age / FALL_TIME;
      const a = CORPSE_TILTS[c.tilt] * t;
      ctx.beginPath();
      addRotatedSquare(ctx, cx, cy, half, Math.cos(a), Math.sin(a));
      ctx.globalAlpha = 1;
      ctx.fillStyle = DARK_COLORS[name];
      ctx.fill();
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = UNIT_COLORS[name];
      ctx.fill();
    });

    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = prevSmoothing;
  }
}
