import { Camera, ObjectiveState } from '../types/types';
import { CONTROL_RADIUS, BASE_RADIUS } from '../engine/Rules';
import { ObjectiveArt } from './ObjectiveArt';
import { SIDE_RGB } from './SideColors';

// Colours by Faction, then the one for no holder (index 2), built once rather than per frame
const RGB = [...SIDE_RGB, '220, 220, 220'];
const rgba = (alpha: number) => RGB.map((c) => `rgba(${c}, ${alpha})`);
const POINT_FILL = rgba(0.12);
const POINT_LINE = rgba(0.8);
const POINT_LABEL = rgba(0.95);
const BASE_FILL = rgba(0.35);
const BASE_LINE = rgba(0.9);
const NO_DASH: number[] = [];

// D30: control points (circle in the colour of the side holding it) and bases (square with
// an HP bar), drawn on the ground under the units. With art (FX on and the art loaded): a flag
// on each point and a tower for each base (ObjectiveArt).
export function drawObjectives(
  ctx: CanvasRenderingContext2D,
  o: ObjectiveState,
  camera: Camera,
  viewW: number,
  viewH: number,
  objectiveArt: ObjectiveArt | null,
  simTime: number
): void {
  const { x: camX, y: camY, zoom } = camera;
  const art = objectiveArt !== null;

  for (const p of o.points) {
    const sx = (p.position.x + 0.5 - camX) * zoom;
    const sy = (p.position.y + 0.5 - camY) * zoom;
    const r = CONTROL_RADIUS * zoom;
    if (sx + r < 0 || sx - r > viewW || sy + r < 0 || sy - r > viewH) continue;
    const c = p.holder === null ? 2 : p.holder;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = POINT_FILL[c];
    ctx.fill();
    ctx.strokeStyle = POINT_LINE[c];
    ctx.lineWidth = 2;
    if (art) ctx.setLineDash([Math.max(4, zoom), Math.max(3, zoom * 0.6)]);
    ctx.stroke();
    ctx.setLineDash(NO_DASH);
    const label = Math.min(28, Math.max(12, zoom * 2.5));
    if (objectiveArt) {
      const size = Math.max(12, zoom * 2);
      objectiveArt.drawFlag(ctx, p.holder, sx, sy + size * 0.4, size, simTime);
    }
    ctx.fillStyle = POINT_LABEL[c];
    ctx.font = art ? `${Math.round(label)}px Pixel, monospace` : `bold ${label}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (art) {
      // Letter beside the flag, outlined for any ground
      const lx = sx + Math.max(12, zoom * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#131b1b';
      ctx.strokeText(p.name, lx, sy);
      ctx.fillText(p.name, lx, sy);
    } else ctx.fillText(p.name, sx, sy);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  for (const b of o.bases) {
    const half = BASE_RADIUS * zoom;
    const sx = (b.position.x + 0.5 - camX) * zoom;
    const sy = (b.position.y + 0.5 - camY) * zoom;
    if (sx + half < 0 || sx - half > viewW || sy + half < 0 || sy - half > viewH) continue;
    if (objectiveArt) {
      objectiveArt.drawTower(ctx, b.faction, b.hp / b.maxHp, sx, sy, half * 2);
    } else {
      ctx.fillStyle = b.hp > 0 ? BASE_FILL[b.faction] : 'rgba(60, 60, 60, 0.5)';
      ctx.fillRect(sx - half, sy - half, half * 2, half * 2);
      ctx.strokeStyle = BASE_LINE[b.faction];
      ctx.lineWidth = 2;
      ctx.strokeRect(sx - half, sy - half, half * 2, half * 2);
    }
    const barH = Math.max(3, zoom * 0.5);
    ctx.fillStyle = '#550000';
    ctx.fillRect(sx - half, sy - half - barH - 2, half * 2, barH);
    ctx.fillStyle = '#00cc44';
    ctx.fillRect(sx - half, sy - half - barH - 2, half * 2 * (b.hp / b.maxHp), barH);
  }
}
