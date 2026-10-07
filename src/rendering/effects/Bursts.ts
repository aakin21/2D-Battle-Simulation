import { Camera } from '../../types/types';
import { Pool } from './Pool';
import slashUrl from '../../assets/fx/slash.png';
import smokeUrl from '../../assets/fx/smoke.png';

// Short sprite animations from the Ninja Adventure FX (CC0): a curved slash where a unit is
// hit and a puff of smoke where one dies. Pooled, so spawning never allocates; when a pool
// is full, extra bursts are simply not shown. Simulation time, so they freeze on pause.

const SLASH_FRAMES = 4; // 32×32 frames in a row
const SMOKE_FRAMES = 6;
const FRAME = 32;
const SLASH_TIME = 0.24; // simulation seconds
const SMOKE_TIME = 0.5;
const SLASH_TILES = 2.2; // drawn size in tiles (units are 2 tiles wide)
const SMOKE_TILES = 3;
// Caps keep crowded stress battles cheap: a few hundred hits per second at most are shown
const MAX_SLASHES = 240;
const MAX_SMOKE = 160;

interface Burst {
  x: number;
  y: number;
  age: number;
  flip: boolean;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

// The slash sheet mirrored frame by frame, so hits from the other side need no transform
function mirrored(img: HTMLImageElement, frames: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  for (let f = 0; f < frames; f++) {
    ctx.save();
    ctx.translate((f + 1) * FRAME, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, f * FRAME, 0, FRAME, FRAME, 0, 0, FRAME, FRAME);
    ctx.restore();
  }
  return c;
}

type Sheet = HTMLImageElement | HTMLCanvasElement;

export class Bursts {
  private slashImg: Sheet | null = null;
  private slashFlipped: Sheet | null = null;
  private smokeImg: Sheet | null = null;
  private slashes = new Pool<Burst>(MAX_SLASHES, () => ({ x: 0, y: 0, age: 0, flip: false }));
  private smoke = new Pool<Burst>(MAX_SMOKE, () => ({ x: 0, y: 0, age: 0, flip: false }));

  constructor() {
    Promise.all([loadImage(slashUrl), loadImage(smokeUrl)])
      .then(([slash, smoke]) => {
        this.slashImg = slash;
        this.slashFlipped = mirrored(slash, SLASH_FRAMES);
        this.smokeImg = smoke;
      })
      .catch((err) => console.warn('Burst sprites not loaded:', err));
  }

  spawnSlash(x: number, y: number, flip: boolean): void {
    if (!this.slashImg) return;
    const b = this.slashes.spawn();
    if (!b) return;
    b.x = x;
    b.y = y;
    b.age = 0;
    b.flip = flip;
  }

  spawnSmoke(x: number, y: number): void {
    if (!this.smokeImg) return;
    const b = this.smoke.spawn();
    if (!b) return;
    b.x = x;
    b.y = y;
    b.age = 0;
    b.flip = false;
  }

  update(dt: number): void {
    this.slashes.update((b) => (b.age += dt) < SLASH_TIME);
    this.smoke.update((b) => (b.age += dt) < SMOKE_TIME);
  }

  clear(): void {
    this.slashes.clear();
    this.smoke.clear();
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number): void {
    this.drawPool(
      ctx,
      camera,
      width,
      height,
      this.smoke,
      this.smokeImg,
      this.smokeImg,
      SMOKE_FRAMES,
      SMOKE_TIME,
      SMOKE_TILES
    );
    this.drawPool(
      ctx,
      camera,
      width,
      height,
      this.slashes,
      this.slashImg,
      this.slashFlipped,
      SLASH_FRAMES,
      SLASH_TIME,
      SLASH_TILES
    );
  }

  private drawPool(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    width: number,
    height: number,
    pool: Pool<Burst>,
    img: Sheet | null,
    flipped: Sheet | null,
    frames: number,
    life: number,
    tiles: number
  ): void {
    if (!img || !flipped || pool.size === 0) return;
    const { x: camX, y: camY, zoom } = camera;
    const size = tiles * zoom;
    const half = size / 2;
    pool.forEach((b) => {
      const sx = (b.x - camX) * zoom;
      const sy = (b.y - camY) * zoom;
      if (sx + half < 0 || sx - half > width || sy + half < 0 || sy - half > height) return;
      const frame = Math.min(frames - 1, Math.floor((b.age / life) * frames));
      const sheet = b.flip ? flipped : img;
      ctx.drawImage(sheet, frame * FRAME, 0, FRAME, FRAME, sx - half, sy - half, size, size);
    });
  }
}
