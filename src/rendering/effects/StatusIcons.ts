import { BehaviorState, Camera, IUnit, UnitType } from '../../types/types';

// Small icons above units: "!" while fleeing, "z" while resting.
// Shown only when zoomed in enough for them to be readable; below that zoom the
// whole pass is skipped. Icons are pre-rendered glyph sprites (fillText per unit
// per frame would be much slower). Animation uses sim time, so it freezes on pause.

// Minimum zoom (px per tile) for icons; units are 2·zoom px wide
const MIN_ZOOM = 9;
// Icon height as a fraction of zoom, clamped to a readable range in px
const ICON_SCALE = 1.4;
const ICON_MIN_PX = 16;
const ICON_MAX_PX = 30;

const GLYPH_PX = 48; // sprite resolution
const FLEE_COLOR = '#ffcc00';
const REST_COLOR = '#9fd8ff';

function makeGlyph(text: string, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = GLYPH_PX;
  const ctx = c.getContext('2d')!;
  ctx.font = `bold ${GLYPH_PX * 0.95}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Dark outline keeps the glyph readable on any terrain
  ctx.lineWidth = GLYPH_PX * 0.14;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1a1a1a';
  ctx.strokeText(text, GLYPH_PX / 2, GLYPH_PX / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, GLYPH_PX / 2, GLYPH_PX / 2);
  return c;
}

export class StatusIcons {
  private flee: HTMLCanvasElement | null = null;
  private rest: HTMLCanvasElement | null = null;

  // Builds the glyph sprites; with a target, draws them once to upload them to the GPU
  prepare(warmTarget?: CanvasRenderingContext2D): void {
    if (this.flee) return;
    this.flee = makeGlyph('!', FLEE_COLOR);
    this.rest = makeGlyph('z', REST_COLOR);
    if (!warmTarget) return;
    warmTarget.drawImage(this.flee, 0, 0, 4, 4);
    warmTarget.drawImage(this.rest, 0, 0, 4, 4);
  }

  draw(
    ctx: CanvasRenderingContext2D,
    units: IUnit[],
    camera: Camera,
    width: number,
    height: number,
    simTime: number
  ): void {
    const { x: camX, y: camY, zoom } = camera;
    if (zoom < MIN_ZOOM) return;
    this.prepare();

    const icon = Math.min(ICON_MAX_PX, Math.max(ICON_MIN_PX, zoom * ICON_SCALE));
    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;

    for (const unit of units) {
      const state = unit.state;
      if (state !== BehaviorState.FLEE && state !== BehaviorState.REST) continue;

      const cx = (unit.position.x - camX) * zoom;
      const cy = (unit.position.y - camY) * zoom;
      if (cx + icon < 0 || cx - icon > width || cy + zoom + icon * 2 < 0 || cy > height) continue;

      // Bars sit at zoom + barH above the unit center (see Renderer.drawBars); the icon
      // goes just above them. Soldiers may have a courage bar (warriors always, berserkers
      // in battle mode), so they get room for it; heroes only have an HP bar.
      const barsH = unit.unitType === UnitType.HERO ? zoom * 0.4 : zoom * 0.65 + 1;
      const top = cy - zoom - barsH - icon - 2;
      // Per-unit phase from position, so neighbours do not move in lockstep
      const phase = unit.position.x * 1.7 + unit.position.y;

      if (state === BehaviorState.FLEE) {
        // Quick small hop
        const hop = Math.abs(Math.sin(simTime * 8 + phase)) * icon * 0.2;
        ctx.globalAlpha = 1;
        ctx.drawImage(this.flee!, cx - icon / 2, top - hop, icon, icon);
      } else {
        // Slow float upward while fading, then repeat
        const t = (simTime * 0.6 + phase) % 1;
        ctx.globalAlpha = 1 - t * 0.5;
        ctx.drawImage(this.rest!, cx - icon / 2 + t * icon * 0.3, top - t * icon * 0.5, icon, icon);
      }
    }

    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = prevSmoothing;
  }
}
