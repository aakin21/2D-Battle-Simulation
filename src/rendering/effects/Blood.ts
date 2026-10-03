import { Camera, GRID_SIZE } from '../../types/types';
import { Pool, RingBuffer } from './Pool';
import type { DeathEvent, HitEvent } from './EffectsManager';
import { makePoolSprites, POOL_ROTATIONS, POOL_SPRITE_CANVAS, POOL_SPRITE_RX } from './sprites';

// Light blood: a few droplets on hit, and a small pool that spreads under each corpse
// and slowly fades. Times are in simulation seconds.
//
// Pools are static once they stop spreading, so settled pools are baked into a
// map-sized layer (like the terrain) and the screen gets one drawImage per frame.
// The layer is rebuilt every BAKE_INTERVAL to apply fading and drop expired pools.
// A rebuild is spread over several frames (BAKE_CHUNK pools per frame) into a back
// layer, which is swapped in when complete, so it never causes a frame spike.
// Pools that are still spreading, or settled after the shown layer was baked, are
// drawn live. When zoomed in past LAYER_MAX_ZOOM, every visible pool is drawn live.

// --- Hit droplets ---
const DROPS_MIN = 2;
const DROPS_MAX = 3;
const DROP_LIFE = 0.35;
const DROP_SPEED_MIN = 1.5; // tiles/s
const DROP_SPEED_MAX = 3.5;
const DROP_DRAG = 4; // velocity decay per second
const MAX_DROPS = 800;
const DROP_COLOR = '#a00000';

// --- Death pools ---
const POOL_GROW_TIME = 0.8; // spreads from POOL_START_SCALE to full size
const POOL_START_SCALE = 0.3;
const POOL_LIFE = 25;
const POOL_FADE_TIME = 8; // last part of POOL_LIFE spent fading out
const POOL_ALPHA = 0.8;
const POOL_RX = 0.45; // radii as a fraction of the unit square side
const POOL_RY = 0.3;
const MAX_POOLS = 1500;
const POOL_COLOR = '#8a0000';
const BAKE_INTERVAL = 1; // sim seconds between layer rebuilds
const BAKE_CHUNK = 200; // pools drawn into the back layer per frame during a rebuild
const LAYER_RES = 8; // layer pixels per tile
// Above this zoom (px per tile) the layer would be visibly upscaled, so all visible
// pools are drawn live from the full-resolution sprites instead. Zoomed in, the view
// covers a small area, so only a few pools are visible.
const LAYER_MAX_ZOOM = 12;
// Unit square side in tiles (Renderer draws units at zoom·2 px; zoom is px per tile)
const UNIT_SIDE_TILES = 2;

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
}

interface BloodPool {
  x: number;
  y: number;
  born: number; // sim time of the death
  scale: number; // random size variation
  rot: number; // index into the pool sprites
}

export class Blood {
  private drops = new Pool<Drop>(MAX_DROPS, () => ({ x: 0, y: 0, vx: 0, vy: 0, age: 0 }));
  private pools = new RingBuffer<BloodPool>(MAX_POOLS, () => ({
    x: 0,
    y: 0,
    born: 0,
    scale: 1,
    rot: 0,
  }));

  // Built by prepare() (needs a DOM)
  private sprites: HTMLCanvasElement[] | null = null;
  // front = shown, back = being rebuilt
  private front: HTMLCanvasElement | null = null;
  private back: HTMLCanvasElement | null = null;
  // Sim time the front layer was baked at; pools settled at or before it are in it
  private bakedAt: number = -Infinity;
  private bakedCount: number = 0;
  // Rebuild in progress: snapshot time, next pool index, pools drawn so far
  private baking: boolean = false;
  private bakeTime: number = 0;
  private bakeCursor: number = 0;
  private bakeCount: number = 0;

  spawnHit(e: HitEvent): void {
    const n = DROPS_MIN + Math.floor(Math.random() * (DROPS_MAX - DROPS_MIN + 1));
    for (let i = 0; i < n; i++) {
      const d = this.drops.spawn();
      if (!d) return;
      const angle = Math.random() * Math.PI * 2;
      const speed = DROP_SPEED_MIN + Math.random() * (DROP_SPEED_MAX - DROP_SPEED_MIN);
      d.x = e.x;
      d.y = e.y;
      d.vx = Math.cos(angle) * speed;
      d.vy = Math.sin(angle) * speed;
      d.age = 0;
    }
  }

  spawnPool(e: DeathEvent, simTime: number): void {
    // Ring buffer: when full, the oldest pool is reused
    const p = this.pools.push();
    p.x = e.x;
    p.y = e.y;
    p.born = simTime;
    p.scale = 0.85 + Math.random() * 0.35;
    p.rot = Math.floor(Math.random() * POOL_ROTATIONS);
  }

  update(dt: number): void {
    if (dt === 0) return;
    const drag = Math.max(0, 1 - DROP_DRAG * dt);
    this.drops.update((d) => {
      d.age += dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vx *= drag;
      d.vy *= drag;
      return d.age < DROP_LIFE;
    });
  }

  clear(): void {
    this.drops.clear();
    this.pools.clear();
    this.bakedAt = -Infinity;
    this.bakedCount = 0;
    this.baking = false;
    for (const layer of [this.front, this.back]) {
      layer?.getContext('2d')!.clearRect(0, 0, layer.width, layer.height);
    }
  }

  get dropCount(): number {
    return this.drops.size;
  }

  // Pools still visible at simTime (expired ones stay in the ring until overwritten)
  countPools(simTime: number): number {
    let n = 0;
    this.pools.forEach((p) => {
      if (simTime - p.born < POOL_LIFE) n++;
    });
    return n;
  }

  drawPools(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    width: number,
    height: number,
    simTime: number
  ): void {
    if (this.pools.size === 0) return;
    this.prepare();

    const { x: camX, y: camY, zoom } = camera;
    const useLayer = zoom <= LAYER_MAX_ZOOM;
    if (useLayer) {
      if (!this.baking && simTime - this.bakedAt >= BAKE_INTERVAL) this.startBake(simTime);
      if (this.baking) this.bakeStep();
    }

    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;

    // Settled pools: one drawImage of the visible part of the layer
    if (useLayer && this.bakedCount > 0) {
      ctx.drawImage(
        this.front!,
        camX * LAYER_RES,
        camY * LAYER_RES,
        (width / zoom) * LAYER_RES,
        (height / zoom) * LAYER_RES,
        0,
        0,
        width,
        height
      );
    }

    // Pools not in the layer (or all pools when zoomed in): drawn live as sprites
    const sprites = this.sprites!;
    const fadeStart = POOL_LIFE - POOL_FADE_TIME;
    this.pools.forEach((p) => {
      if (useLayer && p.born + POOL_GROW_TIME <= this.bakedAt) return;
      const age = simTime - p.born;
      if (age < 0 || age >= POOL_LIFE) return;
      const d = this.poolSpriteSize(p, age) * zoom;
      const cx = (p.x - camX) * zoom;
      const cy = (p.y - camY) * zoom;
      const r = d / 2;
      if (cx + r < 0 || cx - r > width || cy + r < 0 || cy - r > height) return;
      const fade = age < fadeStart ? 1 : 1 - (age - fadeStart) / POOL_FADE_TIME;
      ctx.globalAlpha = POOL_ALPHA * fade;
      ctx.drawImage(sprites[p.rot], cx - r, cy - r, d, d);
    });

    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = prevSmoothing;
  }

  // Side length in tiles of the square sprite canvas for this pool at this age
  private poolSpriteSize(p: BloodPool, age: number): number {
    const grow = age < POOL_GROW_TIME ? age / POOL_GROW_TIME : 1;
    const rx =
      UNIT_SIDE_TILES * POOL_RX * p.scale * (POOL_START_SCALE + (1 - POOL_START_SCALE) * grow);
    return (rx * POOL_SPRITE_CANVAS) / POOL_SPRITE_RX;
  }

  // Builds sprites and layers. Called at startup so the first death causes no hitch.
  // With a target context, every sprite and layer is also drawn once (tiny, then
  // cleared): the browser uploads canvases to the GPU on first use, which otherwise
  // costs a ~15 ms frame (measured 14 ms cold vs 3.5 ms warm for the first frame).
  prepare(warmTarget?: CanvasRenderingContext2D): void {
    if (this.front) return;
    this.sprites = makePoolSprites(POOL_COLOR, POOL_RY / POOL_RX);
    const make = () => {
      const c = document.createElement('canvas');
      c.width = c.height = GRID_SIZE * LAYER_RES;
      return c;
    };
    this.front = make();
    this.back = make();
    if (!warmTarget) return;
    const bctx = this.back.getContext('2d')!;
    for (const sp of this.sprites) bctx.drawImage(sp, 0, 0, 4, 4);
    this.front.getContext('2d')!.drawImage(this.back, 0, 0, 4, 4);
    warmTarget.drawImage(this.front, 0, 0, 4, 4);
    bctx.clearRect(0, 0, this.back.width, this.back.height);
    this.front.getContext('2d')!.clearRect(0, 0, this.front.width, this.front.height);
  }

  private startBake(simTime: number): void {
    const back = this.back!;
    back.getContext('2d')!.clearRect(0, 0, back.width, back.height);
    this.baking = true;
    this.bakeTime = simTime;
    this.bakeCursor = 0;
    this.bakeCount = 0;
  }

  // Draws the next BAKE_CHUNK pools into the back layer, at their fade as of
  // bakeTime. When all pools are done, the back layer becomes the shown one.
  // (If the ring buffer overwrites entries mid-rebuild, a pool may be skipped
  // or drawn twice in that one rebuild; it only happens at MAX_POOLS.)
  private bakeStep(): void {
    const back = this.back!;
    const bctx = back.getContext('2d')!;
    const sprites = this.sprites!;
    const fadeStart = POOL_LIFE - POOL_FADE_TIME;
    const end = Math.min(this.pools.size, this.bakeCursor + BAKE_CHUNK);

    for (let i = this.bakeCursor; i < end; i++) {
      const p = this.pools.get(i);
      const age = this.bakeTime - p.born;
      if (age < POOL_GROW_TIME || age >= POOL_LIFE) continue;
      const fade = age < fadeStart ? 1 : 1 - (age - fadeStart) / POOL_FADE_TIME;
      const d = this.poolSpriteSize(p, age) * LAYER_RES;
      bctx.globalAlpha = POOL_ALPHA * fade;
      bctx.drawImage(sprites[p.rot], p.x * LAYER_RES - d / 2, p.y * LAYER_RES - d / 2, d, d);
      this.bakeCount++;
    }
    bctx.globalAlpha = 1;
    this.bakeCursor = end;

    if (this.bakeCursor >= this.pools.size) {
      this.back = this.front;
      this.front = back;
      this.bakedAt = this.bakeTime;
      this.bakedCount = this.bakeCount;
      this.baking = false;
    }
  }

  drawDrops(ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number): void {
    if (this.drops.size === 0) return;
    const { x: camX, y: camY, zoom } = camera;
    const d = Math.max(1.5, zoom * 0.3);
    const half = d / 2;
    const path = new Path2D();

    this.drops.forEach((p) => {
      const sx = (p.x - camX) * zoom - half;
      const sy = (p.y - camY) * zoom - half;
      if (sx + d < 0 || sx > width || sy + d < 0 || sy > height) return;
      path.rect(sx, sy, d, d);
    });

    ctx.fillStyle = DROP_COLOR;
    ctx.fill(path);
  }
}
