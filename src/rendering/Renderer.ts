import {
  IBattlefield,
  IUnit,
  UnitType,
  TerrainType,
  Camera,
  TERRAIN_COLORS,
  UNIT_COLORS,
  GRID_SIZE,
  TILE_SIZE,
  Position,
} from '../types/types';

const ZOOM_MIN = TILE_SIZE; // full map visible: 150 tiles × 5px = 750px
const ZOOM_MAX = 40; // max zoom: ~19 tiles visible

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Offscreen canvas with full terrain at TILE_SIZE resolution — built once per terrain
  private offscreenTerrain: HTMLCanvasElement | null = null;

  private camera: Camera = { x: 0, y: 0, zoom: ZOOM_MIN };

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    // Disable image smoothing so zoomed terrain stays crisp
    this.ctx.imageSmoothingEnabled = false;
  }

  render(battlefield: IBattlefield): void {
    if (!this.offscreenTerrain) {
      this.buildTerrainCanvas(battlefield.grid);
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawTerrain();
    this.drawUnits(battlefield.units);
    this.drawHPBars(battlefield.units);
  }

  // --- Camera controls ---

  zoomAt(delta: number, mouseCanvasX: number, mouseCanvasY: number): void {
    const factor = delta > 0 ? 1.15 : 1 / 1.15;
    const oldZoom = this.camera.zoom;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldZoom * factor));
    if (newZoom === oldZoom) return;

    // Keep the tile under the mouse cursor fixed on screen
    const mouseGridX = this.camera.x + mouseCanvasX / oldZoom;
    const mouseGridY = this.camera.y + mouseCanvasY / oldZoom;
    this.camera.zoom = newZoom;
    this.camera.x = mouseGridX - mouseCanvasX / newZoom;
    this.camera.y = mouseGridY - mouseCanvasY / newZoom;
    this.clampCamera();
  }

  pan(dx: number, dy: number): void {
    this.camera.x -= dx / this.camera.zoom;
    this.camera.y -= dy / this.camera.zoom;
    this.clampCamera();
  }

  canvasToGrid(canvasX: number, canvasY: number): Position {
    return {
      x: this.camera.x + canvasX / this.camera.zoom,
      y: this.camera.y + canvasY / this.camera.zoom,
    };
  }

  getCamera(): Camera {
    return { ...this.camera };
  }

  // Call on reset — clears terrain and returns camera to default
  clearTerrainCache(): void {
    this.offscreenTerrain = null;
    this.camera = { x: 0, y: 0, zoom: ZOOM_MIN };
  }

  // --- Private helpers ---

  private clampCamera(): void {
    const visW = this.canvas.width / this.camera.zoom;
    const visH = this.canvas.height / this.camera.zoom;
    this.camera.x = Math.max(0, Math.min(Math.max(0, GRID_SIZE - visW), this.camera.x));
    this.camera.y = Math.max(0, Math.min(Math.max(0, GRID_SIZE - visH), this.camera.y));
  }

  private buildTerrainCanvas(grid: TerrainType[][]): void {
    const oc = document.createElement('canvas');
    oc.width = GRID_SIZE * TILE_SIZE;
    oc.height = GRID_SIZE * TILE_SIZE;
    const octx = oc.getContext('2d')!;
    octx.imageSmoothingEnabled = false;

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        octx.fillStyle = TERRAIN_COLORS[TerrainType[grid[y][x]]] ?? '#000';
        octx.fillRect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }

    this.offscreenTerrain = oc;
  }

  private drawTerrain(): void {
    if (!this.offscreenTerrain) return;
    const { x, y, zoom } = this.camera;
    const visW = this.canvas.width / zoom;
    const visH = this.canvas.height / zoom;

    this.ctx.drawImage(
      this.offscreenTerrain,
      x * TILE_SIZE,
      y * TILE_SIZE,
      visW * TILE_SIZE,
      visH * TILE_SIZE,
      0,
      0,
      this.canvas.width,
      this.canvas.height
    );
  }

  private drawUnits(units: IUnit[]): void {
    const { x: camX, y: camY, zoom } = this.camera;
    const size = Math.max(3, zoom * 2);
    const half = size / 2;

    for (const unit of units) {
      const sx = (unit.position.x - camX) * zoom - half;
      const sy = (unit.position.y - camY) * zoom - half;

      if (sx + size < 0 || sx > this.canvas.width) continue;
      if (sy + size < 0 || sy > this.canvas.height) continue;

      this.ctx.fillStyle = UNIT_COLORS[UnitType[unit.unitType]] ?? '#fff';
      this.ctx.fillRect(sx, sy, size, size);

      if (unit.unitType === UnitType.HERO) {
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(sx, sy, size, size);
      }
    }
  }

  private drawHPBars(units: IUnit[]): void {
    const { x: camX, y: camY, zoom } = this.camera;
    const barW = Math.max(6, zoom * 2);
    const barH = Math.max(1, Math.floor(zoom * 0.4));
    const yOff = -(zoom + barH);

    for (const unit of units) {
      const sx = (unit.position.x - camX) * zoom - barW / 2;
      const sy = (unit.position.y - camY) * zoom + yOff;

      if (sx + barW < 0 || sx > this.canvas.width) continue;
      if (sy + barH < 0 || sy > this.canvas.height) continue;

      const ratio = unit.hp / unit.maxHp;
      this.ctx.fillStyle = '#880000';
      this.ctx.fillRect(sx, sy, barW, barH);
      this.ctx.fillStyle = '#00cc44';
      this.ctx.fillRect(sx, sy, Math.max(0, barW * ratio), barH);
    }
  }
}
