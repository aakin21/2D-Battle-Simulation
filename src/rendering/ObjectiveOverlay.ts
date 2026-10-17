import { Camera, Faction, ObjectiveState } from '../types/types';
import { CONTROL_RADIUS, BASE_RADIUS } from '../engine/Rules';
import { ObjectiveArt } from './ObjectiveArt';
import { SIDE_RGB } from './SideColors';

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
  const sideColor = (f: Faction | null) => (f === null ? '220, 220, 220' : SIDE_RGB[f]);
  const art = objectiveArt !== null;

  for (const p of o.points) {
    const sx = (p.position.x + 0.5 - camX) * zoom;
    const sy = (p.position.y + 0.5 - camY) * zoom;
    const r = CONTROL_RADIUS * zoom;
    if (sx + r < 0 || sx - r > viewW || sy + r < 0 || sy - r > viewH) continue;
    const c = sideColor(p.holder);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${c}, 0.12)`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${c}, 0.8)`;
    ctx.lineWidth = 2;
    if (art) ctx.setLineDash([Math.max(4, zoom), Math.max(3, zoom * 0.6)]);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = Math.min(28, Math.max(12, zoom * 2.5));
    if (objectiveArt) {
      const size = Math.max(12, zoom * 2);
      objectiveArt.drawFlag(ctx, p.holder, sx, sy + size * 0.4, size, simTime);
    }
    ctx.fillStyle = `rgba(${c}, 0.95)`;
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
      const c = sideColor(b.faction);
      ctx.fillStyle = b.hp > 0 ? `rgba(${c}, 0.35)` : 'rgba(60, 60, 60, 0.5)';
      ctx.fillRect(sx - half, sy - half, half * 2, half * 2);
      ctx.strokeStyle = `rgba(${c}, 0.9)`;
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
