import {
  IBattlefield,
  IUnit,
  IHero,
  UnitType,
  Faction,
  BehaviorState,
  TerrainType,
  Camera,
  TERRAIN_COLORS,
  UNIT_COLORS,
  GRID_SIZE,
  TILE_SIZE,
  Position,
} from '../types/types';
import { EffectsManager } from './effects/EffectsManager';
import { TerrainArt, ART_PX } from './TerrainArt';
import { ObjectiveArt } from './ObjectiveArt';
import { CONTROL_RADIUS, BASE_RADIUS } from '../engine/Rules';
import { UnitSprites, FRAME, COL_LEFT, COL_RIGHT, WALK_FRAMES, ROW_ATTACK } from './UnitSprites';

// The canvas fills the window, so the smallest zoom is the one that fits the whole map
// (see resize()); until the first resize it is the original 750 px view.
const ZOOM_FIT_DEFAULT = TILE_SIZE; // 150 tiles × 5 px = 750 px
const ZOOM_MAX = 40; // max zoom: ~19 tiles visible on a 750 px view
const ENEMY_HERO_COLOR = '#00E5FF'; // battle mode: enemy heroes stand out from blue berserkers

// Eased camera: fraction of the remaining distance covered per second (exponential)
const CAMERA_EASE_RATE = 18;
// Order feedback: the ring that closes on a new task point, in real seconds
const ORDER_PING_TIME = 0.45;
// Attack pose: the sprite leans this far toward its facing side, as a share of its size
const ATTACK_LUNGE = 0.12;

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Sprite animation
const WALK_FPS = 8;
// Mirrors ATTACK_INTERVAL in SimulationEngine: attackCooldown is reset to it on each hit
const ATTACK_INTERVAL = 1.0;
// The attack frame is shown for this long after each hit
const ATTACK_POSE_TIME = 0.25;
const HERO_RING_COLORS = ['#FFD700', ENEMY_HERO_COLOR]; // by Faction
// Order markers by Faction: west gold, east blue (as in the HUD)
const SIDE_FILL = ['#ffd23f', '#6aa8ff'];
const SIDE_LINE = ['rgba(255, 210, 63, 0.75)', 'rgba(106, 168, 255, 0.75)'];

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Offscreen canvas with full terrain at TILE_SIZE resolution — built once per terrain
  private offscreenTerrain: HTMLCanvasElement | null = null;
  // Terrain and objective art (FX on); the art canvas is built once per map, ART_PX per tile
  private terrainArt = new TerrainArt();
  private artCanvas: HTMLCanvasElement | null = null;
  private objectiveArt = new ObjectiveArt();

  private zoomMin: number = ZOOM_FIT_DEFAULT;
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
  // Bars over units: 'smart' shows them only where something is happening (FX on)
  private barsMode: 'smart' | 'all' = 'smart';
  // Order markers: the command each hero had last frame, and when a new one appeared
  private lastOrders = new Map<string, unknown>();
  // Called each frame with the hits and deaths on screen, for sound (set by the UI)
  private battleSound: ((hits: number, deaths: number, loudness: number) => void) | null = null;
  private orderPings: Array<{ x: number; y: number; faction: Faction; start: number }> = [];
  private selectedUnitId: string | null = null;
  private battleMode: boolean = false;

  private effects = new EffectsManager();
  private unitSprites = new UnitSprites();
  // Whether units (and corpses) are drawn as sprites this frame
  private spriteMode: boolean = false;
  // Cumulative event counts since the last reset — shown in the debug overlay
  private fxHitCount: number = 0;
  private fxDeathCount: number = 0;

  private debugMode: boolean = false;
  private fps: number = 0;
  private fpsFrameCount: number = 0;
  private fpsLastTime: number = 0;

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    // Disable image smoothing so zoomed terrain stays crisp
    this.ctx.imageSmoothingEnabled = false;
    // Warm-up draws land on the canvas, which is cleared on the first render
    this.effects.prepare(this.ctx);
    this.effects.setUnitSprites(this.unitSprites);
    // Squares are drawn until the sprites are ready; on failure they simply stay squares
    this.unitSprites.load(this.ctx).catch((err) => console.warn('Unit sprites not loaded:', err));
    // Flat terrain colours are drawn until the art is ready; on failure they stay
    this.terrainArt.load().catch((err) => console.warn('Terrain art not loaded:', err));
    this.objectiveArt.load().catch((err) => console.warn('Objective art not loaded:', err));
  }

  render(battlefield: IBattlefield): void {
    this.stepCamera(performance.now());
    if (!this.offscreenTerrain) {
      this.buildTerrainCanvas(battlefield.grid);
    }
    if (!this.artCanvas && this.effects.isEnabled() && this.terrainArt.isReady()) {
      this.artCanvas = this.terrainArt.build(battlefield.grid);
    }
    this.updateFps();
    this.updateEffects(battlefield);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.drawTerrain();
    this.drawObjectives(battlefield);
    this.spriteMode = this.decideSpriteMode();
    this.effects.setSpriteMode(this.spriteMode);
    this.effects.drawUnderUnits(
      this.ctx,
      battlefield.units,
      this.camera,
      this.canvas.width,
      this.canvas.height
    );
    this.drawHeroSight(battlefield.units);
    this.drawUnits(battlefield.units);
    this.effects.drawOverUnits(this.ctx, this.camera, this.canvas.width, this.canvas.height);
    this.drawBars(battlefield.units);
    this.effects.drawOverlay(
      this.ctx,
      battlefield.units,
      this.camera,
      this.canvas.width,
      this.canvas.height
    );
    this.drawTaskPoint(battlefield.units);
    if (this.debugMode) this.drawDebugInfo(battlefield);
  }

  // Battle mode: enemy soldiers use courage too, and there are heroes on both sides.
  setBattleMode(on: boolean): void {
    this.battleMode = on;
  }

  setSelectedUnit(id: string | null): void {
    this.selectedUnitId = id;
  }

  setDebugMode(on: boolean): void {
    this.debugMode = on;
  }

  setEffectsEnabled(on: boolean): void {
    this.effects.setEnabled(on);
    this.fxHitCount = 0;
    this.fxDeathCount = 0;
  }

  isEffectsEnabled(): boolean {
    return this.effects.isEnabled();
  }

  // 'smart': with FX on, bars only over units that are hurt, fighting, fleeing, resting,
  // selected, or heroes; 'all': over every unit (FX off always shows all)
  setBattleSound(fn: ((hits: number, deaths: number, loudness: number) => void) | null): void {
    this.battleSound = fn;
  }

  setBarsMode(mode: 'smart' | 'all'): void {
    this.barsMode = mode;
  }

  getBarsMode(): 'smart' | 'all' {
    return this.barsMode;
  }

  // --- Canvas size ---

  // The canvas follows the size of its area in the page. The smallest zoom shows the whole
  // map; a view that was fully zoomed out stays fully zoomed out.
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.canvas.width && h === this.canvas.height) return;
    const wasFit = this.camera.zoom <= this.zoomMin * 1.0001;
    this.zoomEase = null;
    this.panEase = null;
    this.canvas.width = w;
    this.canvas.height = h;
    // Resizing resets the context state
    this.ctx.imageSmoothingEnabled = false;
    this.zoomMin = Math.min(w, h) / GRID_SIZE;
    if (wasFit || this.camera.zoom < this.zoomMin) this.camera.zoom = this.zoomMin;
    this.clampCamera();
  }

  getViewSize(): { width: number; height: number } {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  // Portrait for the selected-unit card: the unit's sprite facing down, scaled by whole
  // pixels. Draws nothing until the sprites are loaded.
  drawPortrait(target: CanvasRenderingContext2D, unit: IUnit): void {
    const { width, height } = target.canvas;
    target.imageSmoothingEnabled = false;
    target.clearRect(0, 0, width, height);
    if (!this.unitSprites.isReady()) return;
    const heroIndex = unit.unitType === UnitType.HERO ? (unit as IHero).heroIndex - 1 : 0;
    const set = this.unitSprites.get(unit.unitType, unit.faction, heroIndex);
    target.drawImage(set.normal, 0, 0, FRAME, FRAME, 0, 0, width, height);
  }

  // --- Camera controls ---

  // Zooms around the cursor. With smooth on (the mouse wheel), the zoom eases to its new
  // value over a few frames; repeated wheel steps add up.
  zoomAt(delta: number, mouseCanvasX: number, mouseCanvasY: number, smooth = false): void {
    const factor = delta > 0 ? 1.15 : 1 / 1.15;
    const from = this.zoomEase ? this.zoomEase.target : this.camera.zoom;
    const target = Math.max(this.zoomMin, Math.min(ZOOM_MAX, from * factor));
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
  private stepCamera(now: number): void {
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

  getCamera(): Camera {
    return { ...this.camera };
  }

  isZoomed(): boolean {
    return this.camera.zoom > this.zoomMin * 1.0001;
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

  // Call on reset — clears terrain and returns camera to default
  clearTerrainCache(): void {
    this.offscreenTerrain = null;
    this.artCanvas = null;
    this.zoomEase = null;
    this.panEase = null;
    this.lastOrders.clear();
    this.orderPings.length = 0;
    this.camera = { x: 0, y: 0, zoom: this.zoomMin };
    this.clampCamera();
    this.selectedUnitId = null;
    this.effects.reset();
    this.fxHitCount = 0;
    this.fxDeathCount = 0;
  }

  // --- Private helpers ---

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

  // The terrain art while effects are on (null until it is built), for the minimap
  getTerrainArt(): HTMLCanvasElement | null {
    return this.effects.isEnabled() ? this.artCanvas : null;
  }

  // Draws the visible part of the map; outside the map the canvas stays clear. With FX on it
  // draws the terrain art: smoothed when it is shown smaller than its own pixels, sharp when
  // it is magnified.
  private drawTerrain(): void {
    const art = this.effects.isEnabled() ? this.artCanvas : null;
    const source = art ?? this.offscreenTerrain;
    if (!source) return;
    const scale = art ? ART_PX : TILE_SIZE;
    const { x, y, zoom } = this.camera;
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(GRID_SIZE, x + this.canvas.width / zoom);
    const y1 = Math.min(GRID_SIZE, y + this.canvas.height / zoom);
    if (x1 <= x0 || y1 <= y0) return;

    const smooth = art !== null && zoom < ART_PX;
    if (smooth) {
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
    }
    this.ctx.drawImage(
      source,
      x0 * scale,
      y0 * scale,
      (x1 - x0) * scale,
      (y1 - y0) * scale,
      (x0 - x) * zoom,
      (y0 - y) * zoom,
      (x1 - x0) * zoom,
      (y1 - y0) * zoom
    );
    if (smooth) this.ctx.imageSmoothingEnabled = false;
  }

  // Sprites are part of the effects layer: FX off shows the original Phase 1 squares.
  // With FX on, units are sprites at every zoom and with no limit on how many are in view.
  // A sprite costs ~1 µs vs ~0.3 µs for a square, so stress mode runs ~16% slower than
  // with squares (see UI_PLAN.md, step 6.2).
  private decideSpriteMode(): boolean {
    return this.effects.isEnabled() && this.unitSprites.isReady();
  }

  private drawUnits(units: IUnit[]): void {
    if (this.spriteMode) {
      this.drawUnitSprites(units);
      return;
    }

    const { x: camX, y: camY, zoom } = this.camera;
    const size = Math.max(3, zoom * 2);
    const half = size / 2;
    const now = performance.now();
    const anyFlash = this.effects.hasFlashes();

    for (const unit of units) {
      const sx = (unit.position.x - camX) * zoom - half;
      const sy = (unit.position.y - camY) * zoom - half;

      if (sx + size < 0 || sx > this.canvas.width) continue;
      if (sy + size < 0 || sy > this.canvas.height) continue;

      this.ctx.fillStyle =
        anyFlash && this.effects.isFlashing(unit.id, now)
          ? '#ffffff'
          : unit.unitType === UnitType.HERO && unit.faction === Faction.ENEMY
            ? ENEMY_HERO_COLOR
            : (UNIT_COLORS[UnitType[unit.unitType]] ?? '#fff');
      this.ctx.fillRect(sx, sy, size, size);

      if (unit.unitType === UnitType.HERO) {
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(sx, sy, size, size);
      }
    }
  }

  private drawUnitSprites(units: IUnit[]): void {
    const { x: camX, y: camY, zoom } = this.camera;
    const size = zoom * 2;
    const half = size / 2;
    const now = performance.now();
    const anyFlash = this.effects.hasFlashes();
    const simTime = this.effects.getSimTime();
    const ctx = this.ctx;

    for (const unit of units) {
      const sx = (unit.position.x - camX) * zoom - half;
      const sy = (unit.position.y - camY) * zoom - half;
      if (sx + size < 0 || sx > this.canvas.width) continue;
      if (sy + size < 0 || sy > this.canvas.height) continue;

      const anim = this.effects.getAnim(unit.id);
      const col = anim.facing > 0 ? COL_RIGHT : COL_LEFT;
      let row = 0; // idle
      if (
        unit.state === BehaviorState.ATTACK &&
        unit.attackCooldown > ATTACK_INTERVAL - ATTACK_POSE_TIME
      ) {
        row = ROW_ATTACK;
      } else if (anim.moving) {
        row = Math.floor(simTime * WALK_FPS + anim.phase * WALK_FRAMES) % WALK_FRAMES;
      }

      // Each hero of a side gets its own sprite (heroIndex is 1-based within the side)
      const heroIndex = unit.unitType === UnitType.HERO ? (unit as IHero).heroIndex - 1 : 0;
      const set = this.unitSprites.get(unit.unitType, unit.faction, heroIndex);

      if (unit.unitType === UnitType.HERO) {
        // Team-colored ring at the hero's feet
        ctx.beginPath();
        ctx.ellipse(sx + half, sy + size * 0.9, half * 0.8, half * 0.3, 0, 0, Math.PI * 2);
        ctx.strokeStyle = HERO_RING_COLORS[unit.faction];
        ctx.lineWidth = Math.max(1.5, zoom * 0.15);
        ctx.stroke();
      }

      const sheet = anyFlash && this.effects.isFlashing(unit.id, now) ? set.flash : set.normal;
      // The attack frame leans toward the facing side, so a hit reads as a lunge
      const lunge = row === ROW_ATTACK ? anim.facing * size * ATTACK_LUNGE : 0;
      ctx.drawImage(sheet, col * FRAME, row * FRAME, FRAME, FRAME, sx + lunge, sy, size, size);
    }
  }

  // Draws HP bar above every unit. Units that use courage (warriors, and berserkers in
  // battle mode) also get a courage bar below the HP bar.
  private drawBars(units: IUnit[]): void {
    const { x: camX, y: camY, zoom } = this.camera;
    const barW = Math.max(6, zoom * 2);
    const hpH = Math.max(1, Math.floor(zoom * 0.4));
    const cH = Math.max(1, Math.floor(zoom * 0.25));

    const smart = this.barsMode === 'smart' && this.effects.isEnabled();
    for (const unit of units) {
      if (
        smart &&
        unit.hp >= unit.maxHp &&
        unit.state === BehaviorState.IDLE &&
        unit.unitType !== UnitType.HERO &&
        unit.id !== this.selectedUnitId
      )
        continue;
      const isWarrior =
        unit.unitType === UnitType.WARRIOR ||
        (this.battleMode && unit.unitType === UnitType.BERSERKER);
      const totalH = isWarrior ? hpH + 1 + cH : hpH;
      const yOff = -(zoom + totalH);

      const sx = (unit.position.x - camX) * zoom - barW / 2;
      const sy = (unit.position.y - camY) * zoom + yOff;

      if (sx + barW < 0 || sx > this.canvas.width) continue;
      if (sy + totalH < 0 || sy > this.canvas.height) continue;

      // HP bar
      const hpRatio = unit.hp / unit.maxHp;
      this.ctx.fillStyle = '#880000';
      this.ctx.fillRect(sx, sy, barW, hpH);
      this.ctx.fillStyle = '#00cc44';
      this.ctx.fillRect(sx, sy, Math.max(0, barW * hpRatio), hpH);

      // Courage bar — warriors only
      if (isWarrior) {
        const cRatio = unit.courage / 100;
        const cy = sy + hpH + 1;
        this.ctx.fillStyle = '#333300';
        this.ctx.fillRect(sx, cy, barW, cH);
        this.ctx.fillStyle = '#ccaa00';
        this.ctx.fillRect(sx, cy, Math.max(0, barW * cRatio), cH);
      }
    }
  }

  private updateEffects(battlefield: IBattlefield): void {
    this.effects.update(battlefield.units, battlefield.elapsedTime);
    this.fxHitCount += this.effects.hits.length;
    this.fxDeathCount += this.effects.deaths.length;
    if (this.battleSound && (this.effects.hits.length || this.effects.deaths.length)) {
      const { x, y, zoom } = this.camera;
      const x1 = x + this.canvas.width / zoom;
      const y1 = y + this.canvas.height / zoom;
      const seen = (e: { x: number; y: number }) => e.x >= x && e.x <= x1 && e.y >= y && e.y <= y1;
      let hits = 0;
      let deaths = 0;
      for (const h of this.effects.hits) if (seen(h)) hits++;
      for (const d of this.effects.deaths) if (seen(d)) deaths++;
      // Closer views are louder: 0.35 at the full map, 1 from about 20 px per tile
      const loudness = Math.min(
        1,
        0.35 + (0.65 * (zoom - this.zoomMin)) / Math.max(1, 20 - this.zoomMin)
      );
      if (hits || deaths) this.battleSound(hits, deaths, loudness);
    }
  }

  private updateFps(): void {
    this.fpsFrameCount++;
    const now = performance.now();
    if (this.fpsLastTime === 0) {
      this.fpsLastTime = now;
      return;
    }
    if (now - this.fpsLastTime >= 1000) {
      this.fps = Math.round((this.fpsFrameCount * 1000) / (now - this.fpsLastTime));
      this.fpsFrameCount = 0;
      this.fpsLastTime = now;
    }
  }

  private drawDebugInfo(battlefield: IBattlefield): void {
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    this.ctx.fillRect(4, 4, 190, 96);
    this.ctx.fillStyle = '#00ff88';
    this.ctx.font = '11px monospace';
    this.ctx.fillText(`FPS: ${this.fps}`, 10, 19);
    this.ctx.fillText(`Units: ${battlefield.units.length}`, 10, 33);
    this.ctx.fillText(`T: ${Math.floor(battlefield.elapsedTime)}s`, 10, 47);
    if (this.effects.isEnabled()) {
      this.ctx.fillText(`FX hits: ${this.fxHitCount}`, 10, 61);
      this.ctx.fillText(`FX deaths: ${this.fxDeathCount}`, 10, 75);
      this.ctx.fillText(
        `corpses ${this.effects.getCorpseCount()} pools ${this.effects.getBloodPoolCount()}`,
        10,
        89
      );
    } else {
      this.ctx.fillText('FX: off', 10, 61);
    }
  }

  // Draws a transparent circle showing the hero's sight range (15 tiles). The charisma
  // radius (influence area) is shown by the hero aura. Only visible while the hero is selected.
  private drawHeroSight(units: IUnit[]): void {
    if (!this.selectedUnitId) return;
    const hero = units.find((u) => u.unitType === UnitType.HERO && u.id === this.selectedUnitId) as
      | IHero
      | undefined;
    if (!hero) return;

    const { x: camX, y: camY, zoom } = this.camera;
    const sx = (hero.position.x - camX) * zoom;
    const sy = (hero.position.y - camY) * zoom;

    this.ctx.beginPath();
    this.ctx.arc(sx, sy, hero.sight * zoom, 0, Math.PI * 2);
    this.ctx.fillStyle = 'rgba(255, 0, 0, 0.08)';
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)';
    this.ctx.lineWidth = 1;
    this.ctx.stroke();
  }

  // Draws an X marker at each hero's current task point (enemy heroes in their own colour).
  // D30: control points (circle in the colour of the side holding it) and bases (square with
  // an HP bar), drawn on the ground under the units.
  private drawObjectives(battlefield: IBattlefield): void {
    const o = battlefield.objective;
    const { x: camX, y: camY, zoom } = this.camera;
    const sideColor = (f: Faction | null) =>
      f === Faction.FRIENDLY
        ? '255, 210, 63'
        : f === Faction.ENEMY
          ? '106, 168, 255'
          : '220, 220, 220';

    // With FX on: a flag on each point and a tower for each base (ObjectiveArt)
    const art = this.effects.isEnabled() && this.objectiveArt.isReady();
    const simTime = this.effects.getSimTime();

    for (const p of o.points) {
      const sx = (p.position.x + 0.5 - camX) * zoom;
      const sy = (p.position.y + 0.5 - camY) * zoom;
      const r = CONTROL_RADIUS * zoom;
      if (sx + r < 0 || sx - r > this.canvas.width || sy + r < 0 || sy - r > this.canvas.height)
        continue;
      const c = sideColor(p.holder);
      this.ctx.beginPath();
      this.ctx.arc(sx, sy, r, 0, Math.PI * 2);
      this.ctx.fillStyle = `rgba(${c}, 0.12)`;
      this.ctx.fill();
      this.ctx.strokeStyle = `rgba(${c}, 0.8)`;
      this.ctx.lineWidth = 2;
      if (art) this.ctx.setLineDash([Math.max(4, zoom), Math.max(3, zoom * 0.6)]);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
      const label = Math.min(28, Math.max(12, zoom * 2.5));
      if (art) {
        const size = Math.max(12, zoom * 2);
        this.objectiveArt.drawFlag(this.ctx, p.holder, sx, sy + size * 0.4, size, simTime);
      }
      this.ctx.fillStyle = `rgba(${c}, 0.95)`;
      this.ctx.font = art ? `${Math.round(label)}px Pixel, monospace` : `bold ${label}px monospace`;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      if (art) {
        // Letter beside the flag, outlined for any ground
        const lx = sx + Math.max(12, zoom * 2);
        this.ctx.lineWidth = 3;
        this.ctx.strokeStyle = '#131b1b';
        this.ctx.strokeText(p.name, lx, sy);
        this.ctx.fillText(p.name, lx, sy);
      } else this.ctx.fillText(p.name, sx, sy);
      this.ctx.textAlign = 'start';
      this.ctx.textBaseline = 'alphabetic';
    }

    for (const b of o.bases) {
      const half = BASE_RADIUS * zoom;
      const sx = (b.position.x + 0.5 - camX) * zoom;
      const sy = (b.position.y + 0.5 - camY) * zoom;
      if (
        sx + half < 0 ||
        sx - half > this.canvas.width ||
        sy + half < 0 ||
        sy - half > this.canvas.height
      )
        continue;
      if (art) {
        this.objectiveArt.drawTower(this.ctx, b.faction, b.hp / b.maxHp, sx, sy, half * 2);
      } else {
        const c = sideColor(b.faction);
        this.ctx.fillStyle = b.hp > 0 ? `rgba(${c}, 0.35)` : 'rgba(60, 60, 60, 0.5)';
        this.ctx.fillRect(sx - half, sy - half, half * 2, half * 2);
        this.ctx.strokeStyle = `rgba(${c}, 0.9)`;
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(sx - half, sy - half, half * 2, half * 2);
      }
      const barH = Math.max(3, zoom * 0.5);
      this.ctx.fillStyle = '#550000';
      this.ctx.fillRect(sx - half, sy - half - barH - 2, half * 2, barH);
      this.ctx.fillStyle = '#00cc44';
      this.ctx.fillRect(sx - half, sy - half - barH - 2, half * 2 * (b.hp / b.maxHp), barH);
    }
  }

  // Each hero's current task point. FX off: the original X. FX on: a small marker in the
  // side's colour, a ring that closes on the point when a new order arrives (from the user,
  // the rules, Jev or the LLM) and a dashed line from the selected hero to its target.
  private drawTaskPoint(units: IUnit[]): void {
    const { x: camX, y: camY, zoom } = this.camera;
    const ctx = this.ctx;
    const fx = this.effects.isEnabled();
    const now = performance.now();
    const half = Math.max(5, zoom * 0.7);

    for (const unit of units) {
      if (unit.unitType !== UnitType.HERO) continue;
      const hero = unit as IHero;
      if (fx) {
        const prev = this.lastOrders.get(hero.id);
        if (hero.command !== prev) {
          this.lastOrders.set(hero.id, hero.command);
          if (prev !== undefined && hero.taskPoint && !reducedMotion()) {
            this.orderPings.push({
              x: hero.taskPoint.x,
              y: hero.taskPoint.y,
              faction: hero.faction,
              start: now,
            });
          }
        }
      }
      if (!hero.taskPoint) continue;

      const sx = (hero.taskPoint.x - camX) * zoom;
      const sy = (hero.taskPoint.y - camY) * zoom;

      if (fx && hero.id === this.selectedUnitId) {
        ctx.strokeStyle = SIDE_LINE[hero.faction];
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo((hero.position.x - camX) * zoom, (hero.position.y - camY) * zoom);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (sx < -20 || sx > this.canvas.width + 20) continue;
      if (sy < -20 || sy > this.canvas.height + 20) continue;

      if (!fx) {
        ctx.strokeStyle = hero.faction === Faction.ENEMY ? ENEMY_HERO_COLOR : '#FF0000';
        ctx.lineWidth = Math.max(1, zoom * 0.2);
        ctx.beginPath();
        ctx.moveTo(sx - half, sy - half);
        ctx.lineTo(sx + half, sy + half);
        ctx.moveTo(sx + half, sy - half);
        ctx.lineTo(sx - half, sy + half);
        ctx.stroke();
        continue;
      }

      // A diamond that bobs gently above the point
      const r = Math.max(4, zoom * 0.55);
      const bob = reducedMotion() ? 0 : Math.sin(now / 220) * r * 0.3;
      const cy = sy - r * 1.4 + bob;
      ctx.beginPath();
      ctx.moveTo(sx, cy - r);
      ctx.lineTo(sx + r * 0.75, cy);
      ctx.lineTo(sx, cy + r);
      ctx.lineTo(sx - r * 0.75, cy);
      ctx.closePath();
      ctx.fillStyle = SIDE_FILL[hero.faction];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#131b1b';
      ctx.stroke();
    }

    // Rings closing on new task points
    let keep = 0;
    for (const ping of this.orderPings) {
      const t = (now - ping.start) / 1000 / ORDER_PING_TIME;
      if (t >= 1) continue;
      this.orderPings[keep++] = ping;
      const px = (ping.x - camX) * zoom;
      const py = (ping.y - camY) * zoom;
      const radius = Math.max(6, zoom * 2.5) * (1 - 0.75 * t);
      ctx.beginPath();
      ctx.ellipse(px, py, radius, radius * 0.6, 0, 0, Math.PI * 2);
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 3;
      ctx.strokeStyle = SIDE_FILL[ping.faction];
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    this.orderPings.length = keep;
  }
}
