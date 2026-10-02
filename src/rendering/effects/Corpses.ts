import { Camera, UnitType, UNIT_COLORS } from '../../types/types';
import { Pool } from './Pool';
import type { DeathEvent } from './EffectsManager';

// Death animation: the unit "falls" (its square collapses into a flat, darker body),
// the body lies for a while, then fades out. Times are in simulation seconds.
const FALL_TIME = 0.4;
const CORPSE_LIFE = 5;
const FADE_TIME = 1.5; // last part of CORPSE_LIFE spent fading out
const LYING_HEIGHT = 0.45; // body height as a fraction of the unit square

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
}

export class Corpses {
  private pool = new Pool<Corpse>(MAX_CORPSES, () => ({
    x: 0,
    y: 0,
    unitType: UnitType.WARRIOR,
    age: 0,
  }));

  spawn(e: DeathEvent): void {
    const c = this.pool.spawn();
    if (!c) return;
    c.x = e.x;
    c.y = e.y;
    c.unitType = e.unitType;
    c.age = 0;
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
    const lyingH = size * LYING_HEIGHT;
    const fadeStart = CORPSE_LIFE - FADE_TIME;

    // Most corpses are lying and fully opaque: collect them into one path per unit
    // type and fill once, instead of thousands of fillRect/globalAlpha changes.
    // Only falling and fading corpses (a small minority) are drawn one by one.
    const lying: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];

    this.pool.forEach((c) => {
      const sx = (c.x - camX) * zoom - half;
      const sy = (c.y - camY) * zoom - half;
      if (sx + size < 0 || sx > width || sy + size < 0 || sy > height) return;

      if (c.age >= FALL_TIME && c.age < fadeStart) {
        lying[c.unitType].rect(sx, sy + size - lyingH, size, lyingH);
        return;
      }

      const name = UnitType[c.unitType];
      if (c.age < FALL_TIME) {
        // Falling: square collapses downward to body height, unit color fades to dark
        const t = c.age / FALL_TIME;
        const h = size + (lyingH - size) * t;
        const top = sy + size - h;
        ctx.globalAlpha = 1;
        ctx.fillStyle = DARK_COLORS[name];
        ctx.fillRect(sx, top, size, h);
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = UNIT_COLORS[name];
        ctx.fillRect(sx, top, size, h);
      } else {
        ctx.globalAlpha = 1 - (c.age - fadeStart) / FADE_TIME;
        ctx.fillStyle = DARK_COLORS[name];
        ctx.fillRect(sx, sy + size - lyingH, size, lyingH);
      }
    });
    ctx.globalAlpha = 1;

    for (let t = 0; t < lying.length; t++) {
      ctx.fillStyle = DARK_COLORS[UnitType[t]];
      ctx.fill(lying[t]);
    }
  }
}
