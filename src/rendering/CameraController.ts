import { Camera, GRID_SIZE, TILE_SIZE, Position } from '../types/types';
import { reducedMotion } from './ReducedMotion';

// The canvas fills the window, so the smallest zoom is the one that fits the whole map
// (see onResize()); until the first resize it is the original 750 px view.
const ZOOM_FIT_DEFAULT = TILE_SIZE; // 150 tiles × 5 px = 750 px
const ZOOM_MAX = 40; // max zoom: ~19 tiles visible on a 750 px view

// Eased camera: fraction of the remaining distance covered per second (exponential)
const CAMERA_EASE_RATE = 18;

// The main view's camera: position and zoom, kept on the map, with eased zooms (mouse wheel)
// and glides (minimap clicks). It reads the canvas size but never draws.
export class CameraController {
  private canvas: HTMLCanvasElement;
  private zoomMinValue: number = ZOOM_FIT_DEFAULT;
  private camera: Camera = { x: 0, y: 0, zoom: ZOOM_FIT_DEFAULT };
  // Eased camera moves: a zoom around a fixed screen point, or a glide to a position
  private zoomEase: {
    target: number;
    screenX: number;
    screenY: number;
    gridX: number;
    gridY: number;
  } | null = null;
  private panEase: { x: number; y: number } | null = null;
  private lastCameraStep = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  // The live camera, read by the drawing code each frame (not a copy: see getCamera())
  get state(): Camera {
    return this.camera;
  }

  // The smallest zoom: the one that shows the whole map
  get zoomMin(): number {
    return this.zoomMinValue;
  }

  // After the canvas was resized: the smallest zoom shows the whole map; a view that was
  // fully zoomed out stays fully zoomed out.
  onResize(): void {
    const wasFit = this.camera.zoom <= this.zoomMinValue * 1.0001;
    this.zoomEase = null;
    this.panEase = null;
    this.zoomMinValue = Math.min(this.canvas.width, this.canvas.height) / GRID_SIZE;
    if (wasFit || this.camera.zoom < this.zoomMinValue) this.camera.zoom = this.zoomMinValue;
    this.clampCamera();
  }

  // Zooms around the cursor. With smooth on (the mouse wheel), the zoom eases to its new
  // value over a few frames; repeated wheel steps add up.
  zoomAt(delta: number, mouseCanvasX: number, mouseCanvasY: number, smooth = false): void {
    const factor = delta > 0 ? 1.15 : 1 / 1.15;
    const from = this.zoomEase ? this.zoomEase.target : this.camera.zoom;
    const target = Math.max(this.zoomMinValue, Math.min(ZOOM_MAX, from * factor));
    if (target === from) return;

    // Keep the tile under the mouse cursor fixed on screen
    const gridX = this.camera.x + mouseCanvasX / this.camera.zoom;
    const gridY = this.camera.y + mouseCanvasY / this.camera.zoom;
    this.panEase = null;
    if (smooth && !reducedMotion()) {
      this.zoomEase = { target, screenX: mouseCanvasX, screenY: mouseCanvasY, gridX, gridY };
      return;
    }
    this.zoomEase = null;
    this.camera.zoom = target;
    this.camera.x = gridX - mouseCanvasX / target;
    this.camera.y = gridY - mouseCanvasY / target;
    this.clampCamera();
  }

  pan(dx: number, dy: number): void {
    this.panEase = null;
    // A zoom still easing keeps its anchor, moved along with the drag
    if (this.zoomEase) {
      this.zoomEase.gridX -= dx / this.camera.zoom;
      this.zoomEase.gridY -= dy / this.camera.zoom;
    }
    this.camera.x -= dx / this.camera.zoom;
    this.camera.y -= dy / this.camera.zoom;
    this.clampCamera();
  }

  // Advances eased zooms and pans; called once per frame with real time.
  step(now: number): void {
    const dt = this.lastCameraStep ? Math.min(0.1, (now - this.lastCameraStep) / 1000) : 0;
    this.lastCameraStep = now;
    const k = 1 - Math.exp(-dt * CAMERA_EASE_RATE);
    const z = this.zoomEase;
    if (z) {
      this.camera.zoom += (z.target - this.camera.zoom) * k;
      if (Math.abs(z.target - this.camera.zoom) < z.target * 0.002) {
        this.camera.zoom = z.target;
        this.zoomEase = null;
      }
      this.camera.x = z.gridX - z.screenX / this.camera.zoom;
      this.camera.y = z.gridY - z.screenY / this.camera.zoom;
      this.clampCamera();
    }
    const p = this.panEase;
    if (p) {
      this.camera.x += (p.x - this.camera.x) * k;
      this.camera.y += (p.y - this.camera.y) * k;
      if (Math.abs(p.x - this.camera.x) + Math.abs(p.y - this.camera.y) < 0.02) {
        this.camera.x = p.x;
        this.camera.y = p.y;
        this.panEase = null;
      }
      this.clampCamera();
    }
  }

  canvasToGrid(canvasX: number, canvasY: number): Position {
    return {
      x: this.camera.x + canvasX / this.camera.zoom,
      y: this.camera.y + canvasY / this.camera.zoom,
    };
  }

  // A copy: callers may keep it without seeing later camera moves
  getCamera(): Camera {
    return { ...this.camera };
  }

  isZoomed(): boolean {
    return this.camera.zoom > this.zoomMinValue * 1.0001;
  }

  // Centres the view on a tile; with smooth on (minimap clicks) the view glides there.
  centerOn(tileX: number, tileY: number, smooth = false): void {
    const visW = this.canvas.width / this.camera.zoom;
    const visH = this.canvas.height / this.camera.zoom;
    this.zoomEase = null;
    if (smooth && !reducedMotion()) {
      // Clamp the destination the same way the camera is clamped
      const keep = { ...this.camera };
      this.camera.x = tileX - visW / 2;
      this.camera.y = tileY - visH / 2;
      this.clampCamera();
      this.panEase = { x: this.camera.x, y: this.camera.y };
      this.camera = keep;
      return;
    }
    this.panEase = null;
    this.camera.x = tileX - visW / 2;
    this.camera.y = tileY - visH / 2;
    this.clampCamera();
  }

  // On reset: no easing, fully zoomed out
  reset(): void {
    this.zoomEase = null;
    this.panEase = null;
    this.camera = { x: 0, y: 0, zoom: this.zoomMinValue };
    this.clampCamera();
  }

  // Keeps the view on the map. Along an axis where the whole map fits, it is centred.
  private clampCamera(): void {
    const visW = this.canvas.width / this.camera.zoom;
    const visH = this.canvas.height / this.camera.zoom;
    this.camera.x =
      visW >= GRID_SIZE
        ? (GRID_SIZE - visW) / 2
        : Math.max(0, Math.min(GRID_SIZE - visW, this.camera.x));
    this.camera.y =
      visH >= GRID_SIZE
        ? (GRID_SIZE - visH) / 2
        : Math.max(0, Math.min(GRID_SIZE - visH, this.camera.y));
  }
}
