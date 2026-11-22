import {
  IBattlefield,
  IUnit,
  UnitType,
  Faction,
  Camera,
  TERRAIN_COLORS,
  terrainName,
  UNIT_COLORS,
  GRID_SIZE,
  ObjectiveState,
  TerrainType,
} from '../types/types';
import { CONTROL_RADIUS, BASE_RADIUS } from '../engine/Rules';
import { SIDE_HEX, SIDE_RGB, hexToRgb } from './SideColors';

// Minimap: terrain and units at one pixel per tile, drawn into a small layer that is scaled
// up by whole pixels, with control points, bases, heroes and the main view's rectangle on top.
// Its terrain colours and markers are exported for Match setup's map preview (MapPreview.ts).

// Marker colours by Faction: SIDE_RGB and SIDE_HEX (SideColors.ts); this one for no holder
const NEUTRAL_RGB = '232, 224, 208';
// Control point colours: by Faction, then the neutral one (index 2) for no holder
const POINT_RGB = [...SIDE_RGB, NEUTRAL_RGB];
const POINT_FILL = POINT_RGB.map((rgb) => `rgba(${rgb}, 0.25)`);
const POINT_LINE = POINT_RGB.map((rgb) => `rgb(${rgb})`);
const BASE_FILL = SIDE_RGB.map((rgb) => `rgb(${rgb})`);
const WHITE: [number, number, number] = [255, 255, 255];
// Soldier pixel colours indexed by UnitType, parsed once (heroes have markers instead)
const UNIT_RGB: Array<[number, number, number]> = [
  hexToRgb(UNIT_COLORS.WARRIOR),
  WHITE,
  hexToRgb(UNIT_COLORS.BERSERKER),
];

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
  // This frame's heroes, in the order of the unit list (reused array)
  private heroes: IUnit[] = [];

  // Cached terrain RGBA bytes — rebuilt on reset and when the terrain art changes
  private terrainPixels: Uint8ClampedArray | null = null;
  private terrainSource: HTMLCanvasElement | null = null;

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

  // art: the main view's terrain art (FX on), shrunk to one pixel per tile; null for the flat
  // terrain colours
  render(battlefield: IBattlefield, camera: Camera, art: HTMLCanvasElement | null = null): void {
    if (art !== this.terrainSource) {
      this.terrainSource = art;
      this.terrainPixels = null;
    }
    if (!this.terrainPixels && art) {
      const c = document.createElement('canvas');
      c.width = GRID_SIZE;
      c.height = GRID_SIZE;
      const cctx = c.getContext('2d')!;
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(art, 0, 0, GRID_SIZE, GRID_SIZE);
      this.terrainPixels = cctx.getImageData(0, 0, GRID_SIZE, GRID_SIZE).data;
    }
    // Build terrain pixel cache once per grid generation
    if (!this.terrainPixels) this.terrainPixels = flatTerrainPixels(battlefield.grid);

    // Copy terrain into reused ImageData
    const data = this.imageData.data;
    data.set(this.terrainPixels);

    // Paint soldiers as single pixels on top; heroes are kept for their markers below
    const units = battlefield.units;
    const heroes = this.heroes;
    heroes.length = 0;
    for (let n = 0; n < units.length; n++) {
      const unit = units[n];
      if (unit.unitType === UnitType.HERO) {
        heroes.push(unit);
        continue;
      }
      const x = Math.floor(unit.position.x);
      const y = Math.floor(unit.position.y);
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const rgb = UNIT_RGB[unit.unitType] ?? WHITE;
      const i = (y * GRID_SIZE + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
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
    drawObjectiveMarkers(ctx, battlefield.objective, s);

    // Heroes: outlined squares in their side's colour
    const heroSize = Math.max(5, s * 3);
    for (const hero of heroes)
      drawHeroMarker(ctx, hero.position.x * s, hero.position.y * s, hero.faction, heroSize);

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

// The terrain at one RGBA pixel per tile in the flat terrain colours
export function flatTerrainPixels(grid: TerrainType[][]): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(GRID_SIZE * GRID_SIZE * 4);
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const type = grid[y][x];
      const [r, g, b] = hexToRgb(TERRAIN_COLORS[terrainName(type)] ?? '#000000');
      const i = (y * GRID_SIZE + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

// Control points (a circle of their capture radius in the holder's colour, neutral without one)
// and bases (a square in their side's colour, grey once destroyed), `s` canvas pixels per tile
export function drawObjectiveMarkers(
  ctx: CanvasRenderingContext2D,
  o: Pick<ObjectiveState, 'points' | 'bases'>,
  s: number
): void {
  ctx.lineWidth = 2;
  for (const p of o.points) {
    const c = p.holder === null ? 2 : p.holder;
    ctx.beginPath();
    ctx.arc((p.position.x + 0.5) * s, (p.position.y + 0.5) * s, CONTROL_RADIUS * s, 0, Math.PI * 2);
    ctx.fillStyle = POINT_FILL[c];
    ctx.fill();
    ctx.strokeStyle = POINT_LINE[c];
    ctx.stroke();
  }
  for (const b of o.bases) {
    const half = BASE_RADIUS * s;
    const cx = (b.position.x + 0.5) * s;
    const cy = (b.position.y + 0.5) * s;
    ctx.fillStyle = b.hp > 0 ? BASE_FILL[b.faction] : '#555';
    ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
    ctx.strokeStyle = '#131b1b';
    ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);
  }
}

// A hero: a square of `size` in its side's colour with a dark outline, centred on (cx, cy)
export function drawHeroMarker(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  faction: Faction,
  size: number
): void {
  ctx.fillStyle = '#131b1b';
  ctx.fillRect(cx - size / 2 - 1, cy - size / 2 - 1, size + 2, size + 2);
  ctx.fillStyle = SIDE_HEX[faction === Faction.ENEMY ? 1 : 0];
  ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
}
