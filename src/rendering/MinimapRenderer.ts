import {
  IBattlefield,
  TerrainType,
  UnitType,
  Camera,
  TERRAIN_COLORS,
  UNIT_COLORS,
  GRID_SIZE,
} from '../types/types';

export class MinimapRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private mainCanvasWidth: number;
  private mainCanvasHeight: number;

  // Reused ImageData — allocated once, updated each frame
  private imageData: ImageData | null = null;

  // Cached terrain RGBA bytes — rebuilt only on reset
  private terrainPixels: Uint8ClampedArray | null = null;

  constructor(canvasId: string, mainCanvasWidth = 750, mainCanvasHeight = 750) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.canvas.width = GRID_SIZE;
    this.canvas.height = GRID_SIZE;
    this.ctx = this.canvas.getContext('2d')!;
    this.mainCanvasWidth = mainCanvasWidth;
    this.mainCanvasHeight = mainCanvasHeight;
  }

  render(battlefield: IBattlefield, camera: Camera): void {
    // Allocate ImageData once
    if (!this.imageData) {
      this.imageData = this.ctx.createImageData(GRID_SIZE, GRID_SIZE);
    }

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
    this.imageData.data.set(this.terrainPixels);

    // Paint units as single pixels on top
    for (const unit of battlefield.units) {
      const x = Math.floor(unit.position.x);
      const y = Math.floor(unit.position.y);
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) continue;
      const [r, g, b] = hexToRgb(UNIT_COLORS[UnitType[unit.unitType]] ?? '#ffffff');
      const i = (y * GRID_SIZE + x) * 4;
      this.imageData.data[i] = r;
      this.imageData.data[i + 1] = g;
      this.imageData.data[i + 2] = b;
      this.imageData.data[i + 3] = 255;
    }

    this.ctx.putImageData(this.imageData, 0, 0);

    // Draw viewport rectangle showing the main canvas's visible area
    const visW = this.mainCanvasWidth / camera.zoom;
    const visH = this.mainCanvasHeight / camera.zoom;
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(camera.x, camera.y, visW, visH);
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
