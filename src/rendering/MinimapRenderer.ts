import {
  IBattlefield,
  IHero,
  TerrainType,
  UnitType,
  Faction,
  Camera,
  TERRAIN_COLORS,
  UNIT_COLORS,
  GRID_SIZE,
} from '../types/types';
import { CONTROL_RADIUS, BASE_RADIUS } from '../engine/Rules';

// Minimap: terrain and units at one pixel per tile, drawn into a small layer that is scaled
// up by whole pixels, with control points, bases, heroes and the main view's rectangle on top.

// Marker colours by Faction (west gold, east blue), as in the unit sprites and the HUD
const SIDE_RGB = ['255, 210, 63', '106, 168, 255'];
const NEUTRAL_RGB = '232, 224, 208';
const HERO_COLORS = ['#ffd23f', '#6aa8ff'];
const WHITE: [number, number, number] = [255, 255, 255];
// Soldier pixel colours by unit type, parsed once
const UNIT_RGB = new Map<UnitType, [number, number, number]>(
  [UnitType.WARRIOR, UnitType.BERSERKER].map((t) => [t, hexToRgb(UNIT_COLORS[UnitType[t]])])
);

export class MinimapRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Size of the main view in pixels, for the view rectangle
  private viewWidth: number = 750;
  private viewHeight: number = 750;

  // GRID_SIZE × GRID_SIZE pixel layer: terrain plus one pixel per unit
  private layer: HTMLCanvasElement;
  private layerCtx: CanvasRenderingContext2D;
  // Reused ImageData — allocated once, updated each frame
  private imageData: ImageData;

  // Cached terrain RGBA bytes — rebuilt only on reset
  private terrainPixels: Uint8ClampedArray | null = null;

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.layer = document.createElement('canvas');
    this.layer.width = GRID_SIZE;
    this.layer.height = GRID_SIZE;
    this.layerCtx = this.layer.getContext('2d')!;
    this.imageData = this.layerCtx.createImageData(GRID_SIZE, GRID_SIZE);
  }

  setViewSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
  }

  render(battlefield: IBattlefield, camera: Camera): void {
    // Build terrain pixel cache once per grid generation
    if (!this.terrainPixels) {
      this.terrainPixels = new Uint8ClampedArray(GRID_SIZE * GRID_SIZE * 4);
      for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
          const type = battlefield.grid[y][x];
          const [r, g, b] = hexToRgb(TERRAIN_COLORS[TerrainType[type]] ?? '#000000');
          const i = (y * GRID_SIZE + x) * 4;
          this.terrainPixels[i] = r;
          this.terrainPixels[i + 1] = g;
          this.terrainPixels[i + 2] = b;
          this.terrainPixels[i + 3] = 255;
        }
      }
    }

    // Copy terrain into reused ImageData
    const data = this.imageData.data;
    data.set(this.terrainPixels);

    // Paint soldiers as single pixels on top; heroes get markers below
    for (const unit of battlefield.units) {
      if (unit.unitType === UnitType.HERO) continue;
      const x = Math.floor(unit.position.x);
      const y = Math.floor(unit.position.y);
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const [r, g, b] = UNIT_RGB.get(unit.unitType) ?? WHITE;
      const i = (y * GRID_SIZE + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    this.layerCtx.putImageData(this.imageData, 0, 0);

    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const s = w / GRID_SIZE; // canvas pixels per tile
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.layer, 0, 0, w, h);

    // Control points and bases
    const o = battlefield.objective;
    ctx.lineWidth = 2;
    for (const p of o.points) {
      const rgb = p.holder === null ? NEUTRAL_RGB : SIDE_RGB[p.holder];
      ctx.beginPath();
      ctx.arc(
        (p.position.x + 0.5) * s,
        (p.position.y + 0.5) * s,
        CONTROL_RADIUS * s,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = `rgba(${rgb}, 0.25)`;
      ctx.fill();
      ctx.strokeStyle = `rgb(${rgb})`;
      ctx.stroke();
    }
    for (const b of o.bases) {
      const half = BASE_RADIUS * s;
      const cx = (b.position.x + 0.5) * s;
      const cy = (b.position.y + 0.5) * s;
      ctx.fillStyle = b.hp > 0 ? `rgb(${SIDE_RGB[b.faction]})` : '#555';
      ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
      ctx.strokeStyle = '#131b1b';
      ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
    }

    // Heroes: outlined squares in their side's colour
    const heroSize = Math.max(5, s * 3);
    for (const unit of battlefield.units) {
      if (unit.unitType !== UnitType.HERO) continue;
      const hero = unit as IHero;
      const cx = hero.position.x * s;
      const cy = hero.position.y * s;
      ctx.fillStyle = '#131b1b';
      ctx.fillRect(cx - heroSize / 2 - 1, cy - heroSize / 2 - 1, heroSize + 2, heroSize + 2);
      ctx.fillStyle = HERO_COLORS[hero.faction === Faction.ENEMY ? 1 : 0];
      ctx.fillRect(cx - heroSize / 2, cy - heroSize / 2, heroSize, heroSize);
    }

    // Rectangle of the main view, clipped to the map
    const x0 = Math.max(0, camera.x);
    const y0 = Math.max(0, camera.y);
    const x1 = Math.min(GRID_SIZE, camera.x + this.viewWidth / camera.zoom);
    const y1 = Math.min(GRID_SIZE, camera.y + this.viewHeight / camera.zoom);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 * s + 1, y0 * s + 1, (x1 - x0) * s - 2, (y1 - y0) * s - 2);
  }

  clearTerrainCache(): void {
    this.terrainPixels = null;
    // imageData object itself is reused — only terrain cache cleared
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
