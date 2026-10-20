import {
  IBattlefield,
  IUnit,
  IHero,
  UnitType,
  TerrainType,
  Camera,
  TERRAIN_COLORS,
  GRID_SIZE,
  TILE_SIZE,
  Position,
} from '../types/types';
import { EffectsManager, HitEvent, DeathEvent } from './effects/EffectsManager';
import { TerrainArt, ART_PX } from './TerrainArt';
import { ObjectiveArt } from './ObjectiveArt';
import { UnitSprites, FRAME } from './UnitSprites';
import { CameraController } from './CameraController';
import { OrderMarkers } from './OrderMarkers';
import { drawObjectives } from './ObjectiveOverlay';
import { UnitLayer } from './UnitLayer';
import { DebugOverlay } from './DebugOverlay';

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  // Offscreen canvas with full terrain at TILE_SIZE resolution — built once per terrain
  private offscreenTerrain: HTMLCanvasElement | null = null;
  // Terrain and objective art (FX on); the art canvas is built once per map, ART_PX per tile
  private terrainArt = new TerrainArt();
  private artCanvas: HTMLCanvasElement | null = null;
  private objectiveArt = new ObjectiveArt();

  // Camera position, zoom and easing (CameraController.ts)
  private view: CameraController;
  // Bars over units: 'smart' shows them only where something is happening (FX on)
  private barsMode: 'smart' | 'all' = 'smart';
  // Task-point markers and the rings for new orders (OrderMarkers.ts)
  private orderMarkers = new OrderMarkers();
  // Called each frame with the hits and deaths on screen, for sound (set by the UI)
  private battleSound: ((hits: number, deaths: number, loudness: number) => void) | null = null;
  private selectedUnitId: string | null = null;
  private battleMode: boolean = false;

  private effects = new EffectsManager();
  private unitSprites = new UnitSprites();
  // Units and their bars, soldiers first and heroes last (UnitLayer.ts)
  private unitLayer = new UnitLayer(this.effects, this.unitSprites);

  private debugMode: boolean = false;
  private debugOverlay = new DebugOverlay();

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.view = new CameraController(this.canvas);
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

  // The live camera of the main view (CameraController); getCamera() returns a copy
  private get camera(): Camera {
    return this.view.state;
  }

  // Draws one frame. The order is the layering: ground, objectives, ground effects (blood,
  // corpses, hero auras), the selected hero's sight, units, effects in the air, bars, status
  // icons, order markers, debug box.
  render(battlefield: IBattlefield): void {
    this.view.step(performance.now());
    if (!this.offscreenTerrain) {
      this.buildTerrainCanvas(battlefield.grid);
    }
    const fx = this.effects.isEnabled();
    if (!this.artCanvas && fx && this.terrainArt.isReady()) {
      this.artCanvas = this.terrainArt.build(battlefield.grid);
    }
    this.debugOverlay.tick();
    this.updateEffects(battlefield);

    const ctx = this.ctx;
    const camera = this.camera;
    const { width, height } = this.canvas;
    const units = battlefield.units;
    this.unitLayer.collectHeroes(units);
    const heroes = this.unitLayer.heroes;

    ctx.clearRect(0, 0, width, height);
    this.drawTerrain();
    drawObjectives(
      ctx,
      battlefield.objective,
      camera,
      width,
      height,
      fx && this.objectiveArt.isReady() ? this.objectiveArt : null,
      this.effects.getSimTime()
    );
    // Sprites are part of the effects layer: FX off shows the original Phase 1 squares.
    // Corpses follow the units' choice.
    const spriteMode = fx && this.unitSprites.isReady();
    this.effects.setSpriteMode(spriteMode);
    this.effects.drawUnderUnits(ctx, heroes, camera, width, height);
    this.drawHeroSight(heroes);
    this.unitLayer.drawUnits(ctx, units, camera, width, height, spriteMode);
    this.effects.drawOverUnits(ctx, camera, width, height);
    this.unitLayer.drawBars(
      ctx,
      units,
      camera,
      width,
      height,
      this.barsMode === 'smart' && fx,
      this.selectedUnitId,
      this.battleMode
    );
    this.effects.drawOverlay(ctx, units, camera, width, height);
    this.orderMarkers.draw(ctx, heroes, camera, width, height, fx, this.selectedUnitId);
    if (this.debugMode) this.debugOverlay.draw(ctx, battlefield, this.effects);
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
    this.debugOverlay.resetCounts();
  }

  isEffectsEnabled(): boolean {
    return this.effects.isEnabled();
  }

  setBattleSound(fn: ((hits: number, deaths: number, loudness: number) => void) | null): void {
    this.battleSound = fn;
  }

  // 'smart': with FX on, bars only over units that are hurt, fighting, fleeing, resting,
  // selected, or heroes; 'all': over every unit (FX off always shows all)
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
    this.canvas.width = w;
    this.canvas.height = h;
    // Resizing resets the context state
    this.ctx.imageSmoothingEnabled = false;
    this.view.onResize();
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

  // --- Camera controls (CameraController) ---

  // Zooms around the cursor. With smooth on (the mouse wheel), the zoom eases to its new
  // value over a few frames; repeated wheel steps add up.
  zoomAt(delta: number, mouseCanvasX: number, mouseCanvasY: number, smooth = false): void {
    this.view.zoomAt(delta, mouseCanvasX, mouseCanvasY, smooth);
  }

  pan(dx: number, dy: number): void {
    this.view.pan(dx, dy);
  }

  canvasToGrid(canvasX: number, canvasY: number): Position {
    return this.view.canvasToGrid(canvasX, canvasY);
  }

  // A copy of the camera (the simulation engine keeps it)
  getCamera(): Camera {
    return this.view.getCamera();
  }

  isZoomed(): boolean {
    return this.view.isZoomed();
  }

  // Centres the view on a tile; with smooth on (minimap clicks) the view glides there.
  centerOn(tileX: number, tileY: number, smooth = false): void {
    this.view.centerOn(tileX, tileY, smooth);
  }

  // Effects and order markers keep per-unit history; a replay that jumps back starts them over
  resetHistory(): void {
    this.orderMarkers.reset();
    this.effects.reset();
  }

  // Call on reset — clears terrain and returns camera to default
  clearTerrainCache(): void {
    this.offscreenTerrain = null;
    this.artCanvas = null;
    this.orderMarkers.reset();
    this.view.reset();
    this.selectedUnitId = null;
    this.effects.reset();
    this.debugOverlay.resetCounts();
  }

  // --- Private helpers ---

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

  // Finds this frame's hits and deaths (effects) and plays the ones in view (battle sound)
  private updateEffects(battlefield: IBattlefield): void {
    const { hits, deaths } = this.effects;
    this.effects.update(battlefield.units, battlefield.elapsedTime);
    this.debugOverlay.countEvents(hits.length, deaths.length);
    if (this.battleSound && (hits.length || deaths.length)) {
      const { zoom } = this.camera;
      const seenHits = this.countInView(hits);
      const seenDeaths = this.countInView(deaths);
      // Closer views are louder: 0.35 at the full map, 1 from about 20 px per tile
      const loudness = Math.min(
        1,
        0.35 + (0.65 * (zoom - this.view.zoomMin)) / Math.max(1, 20 - this.view.zoomMin)
      );
      if (seenHits || seenDeaths) this.battleSound(seenHits, seenDeaths, loudness);
    }
  }

  // How many of the events lie in the main view
  private countInView(events: readonly (HitEvent | DeathEvent)[]): number {
    const { x, y, zoom } = this.camera;
    const x1 = x + this.canvas.width / zoom;
    const y1 = y + this.canvas.height / zoom;
    let n = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.x >= x && e.x <= x1 && e.y >= y && e.y <= y1) n++;
    }
    return n;
  }

  // Draws a transparent circle showing the selected hero's sight range (hero.sight tiles). The
  // charisma radius (influence area) is shown by the hero aura.
  private drawHeroSight(heroes: readonly IUnit[]): void {
    if (!this.selectedUnitId) return;
    let hero: IUnit | undefined;
    for (let i = 0; i < heroes.length && !hero; i++) {
      if (heroes[i].id === this.selectedUnitId) hero = heroes[i];
    }
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
}
