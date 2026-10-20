import { IUnit, IHero, UnitType, Faction, Camera } from '../types/types';
import { SIDE_HEX, SIDE_RGB, ENEMY_HERO_COLOR } from './SideColors';
import { reducedMotion } from './ReducedMotion';

// Order feedback: the ring that closes on a new task point, in real seconds
const ORDER_PING_TIME = 0.45;
// Order markers by Faction: west gold, east blue (as in the HUD)
const SIDE_FILL = SIDE_HEX;
const SIDE_LINE = SIDE_RGB.map((rgb) => `rgba(${rgb}, 0.75)`);
// Dash pattern of the selected hero's line (setLineDash copies the array)
const LINE_DASH = [6, 5];
const NO_DASH: number[] = [];

// Each hero's current task point. FX off: the original X. FX on: a small marker in the
// side's colour, a ring that closes on the point when a new order arrives (from the user,
// the rules, Jev or the LLM) and a dashed line from the selected hero to its target.
export class OrderMarkers {
  // The command each hero had last frame, and the rings for orders that just appeared
  private lastOrders = new Map<string, unknown>();
  private orderPings: Array<{ x: number; y: number; faction: Faction; start: number }> = [];

  // On reset: forget the last orders and drop the rings
  reset(): void {
    this.lastOrders.clear();
    this.orderPings.length = 0;
  }

  // heroes: this frame's heroes (other units are skipped)
  draw(
    ctx: CanvasRenderingContext2D,
    heroes: readonly IUnit[],
    camera: Camera,
    viewW: number,
    viewH: number,
    fx: boolean,
    selectedUnitId: string | null
  ): void {
    const { x: camX, y: camY, zoom } = camera;
    const now = performance.now();
    const half = Math.max(5, zoom * 0.7);

    for (let i = 0; i < heroes.length; i++) {
      if (heroes[i].unitType !== UnitType.HERO) continue;
      const hero = heroes[i] as IHero;
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

      if (fx && hero.id === selectedUnitId) {
        ctx.strokeStyle = SIDE_LINE[hero.faction];
        ctx.lineWidth = 2;
        ctx.setLineDash(LINE_DASH);
        ctx.beginPath();
        ctx.moveTo((hero.position.x - camX) * zoom, (hero.position.y - camY) * zoom);
        ctx.lineTo(sx, sy);
        ctx.stroke();
        ctx.setLineDash(NO_DASH);
      }

      if (sx < -20 || sx > viewW + 20) continue;
      if (sy < -20 || sy > viewH + 20) continue;

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
