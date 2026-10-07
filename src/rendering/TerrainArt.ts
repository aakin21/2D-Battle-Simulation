import { GRID_SIZE, TerrainType } from '../types/types';
import floorUrl from '../assets/terrain/TilesetFloor.png';
import natureUrl from '../assets/terrain/TilesetNature.png';
import waterUrl from '../assets/terrain/TilesetWater.png';

// Battlefield art from the Ninja Adventure tilesets (CC0, D25), built once per map.
//
// The art has 8 pixels per tile: the unit sprites are 16 px wide and drawn over 2 tiles, so
// ground and units share one pixel size. Terrain edges follow the simulation's tiles: each
// pixel takes the terrain with the largest bilinear weight among the four nearest tile
// centres, plus a little noise. Edges therefore move at most ~1.5 px from the real tile edge
// and corners come out rounded. Trees, rocks, reeds and flowers are only placed where every
// tile under them has the matching terrain, so the picture never shows a terrain the
// simulation does not use. Placement uses a hash of the tile position, never Math.random.

export const ART_PX = 8;
const SIZE = GRID_SIZE * ART_PX;
const TILE = 16; // tileset tile size

// Drawing order of terrain types where they meet: the higher one gets the outline
const PRIORITY = [0, 1, 2, 3]; // OPEN, FOREST, SWAMP, MOUNTAIN

// Edge noise: lattice spacing in pixels and amplitude (in units of bilinear weight)
const NOISE_STEP = 4;
const NOISE_AMP = 0.18;

// Packs a colour as the Uint32 value of an RGBA pixel (little-endian)
function pack(r: number, g: number, b: number, a = 255): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function hex(h: string): number {
  const n = parseInt(h.slice(1), 16);
  return pack((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

// Deterministic hash of integer coordinates to [0, 1)
function hash(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

interface Sheet {
  w: number;
  h: number;
  px: Uint32Array;
  img: HTMLImageElement;
}

function readSheet(img: HTMLImageElement): Sheet {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  return { w: c.width, h: c.height, px: new Uint32Array(data.data.buffer), img };
}

// A 16×16 tile of a sheet, optionally with some colours replaced
function tile(sheet: Sheet, tx: number, ty: number, recolor?: Map<number, number>): Uint32Array {
  const out = new Uint32Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const p = sheet.px[(ty * TILE + y) * sheet.w + tx * TILE + x];
      out[y * TILE + x] = recolor?.get(p) ?? p;
    }
  }
  return out;
}

function colorMap(pairs: Array<[string, string]>): Map<number, number> {
  return new Map(pairs.map(([a, b]) => [hex(a), hex(b)]));
}

interface Sprite {
  canvas: HTMLCanvasElement;
  cw: number; // footprint in tiles
  ch: number;
}

// Cuts a sprite out of a sheet; `keep` can drop pixels (e.g. the water around a lily pad)
function sprite(
  sheet: Sheet,
  x: number,
  y: number,
  w: number,
  h: number,
  recolor?: Map<number, number>,
  keep?: (p: number) => boolean
): Sprite {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const data = ctx.createImageData(w, h);
  const out = new Uint32Array(data.data.buffer);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const p = sheet.px[(y + yy) * sheet.w + x + xx];
      if (p >>> 24 === 0 || (keep && !keep(p))) continue;
      out[yy * w + xx] = recolor?.get(p) ?? p;
    }
  }
  ctx.putImageData(data, 0, 0);
  return { canvas: c, cw: Math.ceil(w / ART_PX), ch: Math.ceil(h / ART_PX) };
}

interface Ground {
  plain: Uint32Array;
  variants: Uint32Array[];
  variantShare: number; // share of 16×16 blocks that use a variant instead of the plain tile
  outline: number; // edge colour where this terrain meets a lower one
  rim?: number; // second line inside the edge (water foam)
}

interface Placement {
  sprite: Sprite;
  cx: number;
  cy: number;
}

export class TerrainArt {
  private ground: Ground[] = [];
  private trees: Sprite[] = [];
  private bushes: Sprite[] = [];
  private rocksLarge: Sprite[] = [];
  private rocksMedium: Sprite[] = [];
  private rocksSmall: Sprite[] = [];
  private flowers: Sprite[] = [];
  private tufts: Sprite[] = [];
  private reeds: Sprite[] = [];
  private lilies: Sprite[] = [];
  private ready = false;

  async load(): Promise<void> {
    const [floorImg, natureImg, waterImg] = await Promise.all([
      loadImage(floorUrl),
      loadImage(natureUrl),
      loadImage(waterUrl),
    ]);
    const floor = readSheet(floorImg);
    const nature = readSheet(natureImg);
    const water = readSheet(waterImg);

    // Ground textures. Open ground: the lime grass; forest floor: the darker grass.
    const open: Ground = {
      plain: tile(floor, 0, 12),
      variants: [
        [1, 12],
        [2, 12],
        [3, 12],
        [4, 12],
        [2, 11],
        [3, 11],
      ].map(([x, y]) => tile(floor, x, y)),
      variantShare: 0.45,
      outline: hex('#8a9a2e'),
    };
    const forest: Ground = {
      plain: tile(floor, 11, 12),
      variants: [
        [12, 12],
        [13, 12],
        [14, 12],
        [15, 12],
      ].map(([x, y]) => tile(floor, x, y)),
      variantShare: 0.5,
      outline: hex('#3f6e3f'),
    };
    // Swamp: the pack's water, recoloured to murky green
    // Both water tones map to one base colour, so tile variants do not form a checkerboard
    const murky = colorMap([
      ['#79b8ce', '#5b7f6c'],
      ['#71ddee', '#5b7f6c'],
      ['#8feff1', '#77a07f'],
      ['#a3c5c3', '#77a07f'],
      ['#54a0bf', '#4a6a5a'],
    ]);
    const swamp: Ground = {
      plain: tile(water, 11, 0, murky),
      variants: [tile(water, 11, 1, murky), tile(water, 11, 2, murky), tile(water, 1, 1, murky)],
      variantShare: 0.35,
      outline: hex('#2f4a3b'),
      rim: hex('#a7c48f'),
    };
    // Mountains: the pack's dark earth recoloured to the grey-green of its rocks
    const rock = colorMap([
      ['#90775e', '#7d8873'],
      ['#816855', '#68735f'],
      ['#b3957f', '#9aa48c'],
      ['#8e7c73', '#76806b'],
    ]);
    const mountain: Ground = {
      plain: tile(floor, 12, 15, rock),
      variants: [tile(floor, 19, 15, rock), tile(floor, 20, 16, rock)],
      variantShare: 0.4,
      outline: hex('#3e4a3f'),
    };
    this.ground = [open, forest, swamp, mountain];

    // Decorations (positions in TilesetNature, checked against their pixel bounds)
    this.trees = [
      sprite(nature, 32, 0, 32, 32), // pine
      sprite(nature, 32, 0, 32, 32),
      sprite(nature, 0, 0, 32, 32), // round, light
      sprite(nature, 256, 0, 32, 32), // round, green
    ];
    this.bushes = [0, 16, 32, 48].map((x) => sprite(nature, x, 160, 16, 16));
    // Brown and blue rocks recoloured to the grey-green ones, for more shapes (the brown
    // rocks are an exact palette swap of the grey ones)
    const greyRock = colorMap([
      ['#965746', '#5f7160'],
      ['#c69469', '#8d977f'],
      ['#bd7959', '#56634d'],
      ['#d2b37d', '#b6beb0'],
      ['#548789', '#8d977f'],
      ['#2d697b', '#5f7160'],
      ['#4a5270', '#56634d'],
      ['#748e90', '#b6beb0'],
    ]);
    this.rocksLarge = [sprite(nature, 256, 80, 64, 48), sprite(nature, 192, 80, 64, 48, greyRock)];
    this.rocksMedium = [
      sprite(nature, 256, 128, 32, 32),
      sprite(nature, 208, 128, 32, 32, greyRock),
      sprite(nature, 0, 192, 32, 32, greyRock),
    ];
    this.rocksSmall = [
      sprite(nature, 288, 144, 16, 16),
      sprite(nature, 240, 144, 16, 16, greyRock),
      sprite(nature, 128, 192, 16, 16, greyRock),
      sprite(nature, 112, 192, 16, 16, greyRock),
      sprite(nature, 176, 192, 16, 16),
    ];
    this.flowers = [0, 16, 48, 96].map((x) => sprite(nature, x, 176, 16, 16));
    this.tufts = [64, 80, 112].map((x) => sprite(nature, x, 160, 16, 16));
    const reedColors = colorMap([
      ['#adbc3a', '#6f8f4a'],
      ['#74a334', '#4f6f3c'],
    ]);
    this.reeds = [sprite(nature, 96, 160, 16, 16, reedColors)];
    const padGreens = new Set([hex('#adbc3a'), hex('#74a334')]);
    this.lilies = [sprite(water, 176, 48, 16, 16, undefined, (p) => padGreens.has(p))];

    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  // Builds the art for a map: a GRID_SIZE·8 square canvas.
  build(grid: TerrainType[][]): HTMLCanvasElement {
    const types = this.groundTypes(grid);
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d')!;
    const image = ctx.createImageData(SIZE, SIZE);
    this.paintGround(new Uint32Array(image.data.buffer), types, grid);
    ctx.putImageData(image, 0, 0);
    this.paintDecorations(ctx, grid);
    return canvas;
  }

  // Terrain type of every art pixel (see the comment at the top of the file).
  private groundTypes(grid: TerrainType[][]): Uint8Array {
    const types = new Uint8Array(SIZE * SIZE);
    const at = (x: number, y: number) =>
      grid[Math.max(0, Math.min(GRID_SIZE - 1, y))][Math.max(0, Math.min(GRID_SIZE - 1, x))];
    const noise = (px: number, py: number, t: number) => {
      const gx = px / NOISE_STEP;
      const gy = py / NOISE_STEP;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const n00 = hash(x0, y0, t);
      const n10 = hash(x0 + 1, y0, t);
      const n01 = hash(x0, y0 + 1, t);
      const n11 = hash(x0 + 1, y0 + 1, t);
      const v = (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
      return (v * 2 - 1) * NOISE_AMP;
    };

    const weight = new Float32Array(4);
    for (let cy = 0; cy < GRID_SIZE; cy++) {
      for (let cx = 0; cx < GRID_SIZE; cx++) {
        const t = grid[cy][cx];
        let uniform = true;
        for (let dy = -1; dy <= 1 && uniform; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (at(cx + dx, cy + dy) !== t) {
              uniform = false;
              break;
            }
          }
        }
        if (uniform) {
          for (let y = 0; y < ART_PX; y++) {
            const row = (cy * ART_PX + y) * SIZE + cx * ART_PX;
            types.fill(t, row, row + ART_PX);
          }
          continue;
        }
        // Mixed neighbourhood: weigh the four nearest tile centres for each pixel
        for (let y = 0; y < ART_PX; y++) {
          const py = cy * ART_PX + y;
          const v = (py + 0.5) / ART_PX - 0.5;
          const j0 = Math.floor(v);
          const fy = v - j0;
          for (let x = 0; x < ART_PX; x++) {
            const px = cx * ART_PX + x;
            const u = (px + 0.5) / ART_PX - 0.5;
            const i0 = Math.floor(u);
            const fx = u - i0;
            weight.fill(0);
            weight[at(i0, j0)] += (1 - fx) * (1 - fy);
            weight[at(i0 + 1, j0)] += fx * (1 - fy);
            weight[at(i0, j0 + 1)] += (1 - fx) * fy;
            weight[at(i0 + 1, j0 + 1)] += fx * fy;
            let best = -1;
            let bestScore = -Infinity;
            for (let k = 0; k < 4; k++) {
              if (weight[k] === 0) continue;
              const score = weight[k] + noise(px, py, k) + PRIORITY[k] * 1e-6;
              if (score > bestScore) {
                bestScore = score;
                best = k;
              }
            }
            types[py * SIZE + px] = best;
          }
        }
      }
    }
    return types;
  }

  // Texture for every pixel, then an outline where a terrain meets a lower one.
  private paintGround(out: Uint32Array, types: Uint8Array, grid: TerrainType[][]): void {
    const pick = (t: number, bx: number, by: number): Uint32Array => {
      const g = this.ground[t];
      const r = hash(bx, by, 17 + t);
      if (r >= g.variantShare) return g.plain;
      return g.variants[Math.floor((r / g.variantShare) * g.variants.length)];
    };
    for (let by = 0; by < SIZE / TILE; by++) {
      for (let bx = 0; bx < SIZE / TILE; bx++) {
        for (let y = 0; y < TILE; y++) {
          const py = by * TILE + y;
          for (let x = 0; x < TILE; x++) {
            const px = bx * TILE + x;
            const i = py * SIZE + px;
            out[i] = pick(types[i], bx, by)[y * TILE + x];
          }
        }
      }
    }

    // Edges only occur in tiles whose neighbourhood is mixed
    const typeAt = (px: number, py: number) =>
      px < 0 || py < 0 || px >= SIZE || py >= SIZE ? -1 : types[py * SIZE + px];
    for (let cy = 0; cy < GRID_SIZE; cy++) {
      for (let cx = 0; cx < GRID_SIZE; cx++) {
        let mixed = false;
        const t0 = grid[cy][cx];
        for (let dy = -1; dy <= 1 && !mixed; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const y = cy + dy;
            const x = cx + dx;
            if (x >= 0 && y >= 0 && x < GRID_SIZE && y < GRID_SIZE && grid[y][x] !== t0) {
              mixed = true;
              break;
            }
          }
        }
        if (!mixed) continue;
        for (let y = 0; y < ART_PX; y++) {
          for (let x = 0; x < ART_PX; x++) {
            const px = cx * ART_PX + x;
            const py = cy * ART_PX + y;
            const t = types[py * SIZE + px];
            const g = this.ground[t];
            let edge = false;
            let near = false;
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              const n = typeAt(px + dx, py + dy);
              if (n >= 0 && PRIORITY[n] < PRIORITY[t]) edge = true;
              const n2 = typeAt(px + 2 * dx, py + 2 * dy);
              if (n2 >= 0 && PRIORITY[n2] < PRIORITY[t]) near = true;
            }
            if (edge) out[py * SIZE + px] = g.outline;
            else if (near && g.rim !== undefined) out[py * SIZE + px] = g.rim;
          }
        }
      }
    }
  }

  // Trees, rocks, reeds, lily pads, flowers and grass tufts, drawn bottom to top.
  private paintDecorations(ctx: CanvasRenderingContext2D, grid: TerrainType[][]): void {
    const used = new Uint8Array(GRID_SIZE * GRID_SIZE);
    const placed: Placement[] = [];
    const fits = (cx: number, cy: number, s: Sprite, t: TerrainType, free: boolean) => {
      if (cx < 0 || cy < 0 || cx + s.cw > GRID_SIZE || cy + s.ch > GRID_SIZE) return false;
      for (let y = cy; y < cy + s.ch; y++) {
        for (let x = cx; x < cx + s.cw; x++) {
          if (grid[y][x] !== t) return false;
          if (free && used[y * GRID_SIZE + x]) return false;
        }
      }
      return true;
    };
    const place = (s: Sprite, cx: number, cy: number, mark: boolean) => {
      placed.push({ sprite: s, cx, cy });
      if (!mark) return;
      for (let y = cy; y < cy + s.ch; y++) {
        for (let x = cx; x < cx + s.cw; x++) used[y * GRID_SIZE + x] = 1;
      }
    };
    const choose = (list: Sprite[], cx: number, cy: number, salt: number) =>
      list[Math.floor(hash(cx, cy, salt) * list.length)];

    // A jittered grid of candidate positions for one kind of decoration
    const scatter = (
      step: number,
      salt: number,
      chance: number,
      each: (cx: number, cy: number) => void
    ) => {
      for (let gy = 0; gy < GRID_SIZE; gy += step) {
        for (let gx = 0; gx < GRID_SIZE; gx += step) {
          if (hash(gx, gy, salt) >= chance) continue;
          const jx = Math.floor(hash(gx, gy, salt + 1) * step);
          const jy = Math.floor(hash(gx, gy, salt + 2) * step);
          each(gx + jx, gy + jy);
        }
      }
    };

    // Mountains: large rock groups first, then single rocks into the gaps
    scatter(6, 31, 0.9, (cx, cy) => {
      const s = choose(this.rocksLarge, cx, cy, 32);
      if (fits(cx, cy, s, TerrainType.MOUNTAIN, true)) place(s, cx, cy, true);
    });
    scatter(4, 41, 0.8, (cx, cy) => {
      const s = choose(this.rocksMedium, cx, cy, 42);
      if (fits(cx, cy, s, TerrainType.MOUNTAIN, true)) place(s, cx, cy, true);
    });
    scatter(3, 51, 0.45, (cx, cy) => {
      const s = choose(this.rocksSmall, cx, cy, 52);
      if (fits(cx, cy, s, TerrainType.MOUNTAIN, true)) place(s, cx, cy, true);
    });

    // Forests: overlapping trees, bushes where a tree does not fit
    scatter(3, 61, 0.95, (cx, cy) => {
      const s = choose(this.trees, cx, cy, 62);
      if (fits(cx, cy, s, TerrainType.FOREST, false)) place(s, cx, cy, true);
    });
    scatter(2, 71, 0.55, (cx, cy) => {
      const s = choose(this.bushes, cx, cy, 72);
      if (fits(cx, cy, s, TerrainType.FOREST, true)) place(s, cx, cy, true);
    });

    // Swamps: reeds and lily pads
    scatter(3, 81, 0.25, (cx, cy) => {
      const s = choose([...this.reeds, ...this.lilies], cx, cy, 82);
      if (fits(cx, cy, s, TerrainType.SWAMP, true)) place(s, cx, cy, true);
    });

    // Open ground: a few flowers and grass tufts
    scatter(4, 91, 0.12, (cx, cy) => {
      const s = choose(this.flowers, cx, cy, 92);
      if (fits(cx, cy, s, TerrainType.OPEN, true)) place(s, cx, cy, true);
    });
    scatter(3, 101, 0.1, (cx, cy) => {
      const s = choose(this.tufts, cx, cy, 102);
      if (fits(cx, cy, s, TerrainType.OPEN, true)) place(s, cx, cy, true);
    });

    placed.sort((a, b) => a.cy + a.sprite.ch - (b.cy + b.sprite.ch) || a.cx - b.cx);
    for (const p of placed) ctx.drawImage(p.sprite.canvas, p.cx * ART_PX, p.cy * ART_PX);
  }
}
