import { Camera, Faction, IHero, IUnit, UnitType } from '../../types/types';

// A soft pulsing aura around each hero showing its charisma radius — the area in
// which its soldiers get the courage bonus (SimulationEngine uses hero.charismaRadius).
// A faint glow breathes, and a ripple ring expands toward the edge and fades.
// At most a few heroes exist, so this costs a handful of draw calls per hero. Sim time
// drives the animation, so it freezes on pause.

const PULSE_PERIOD = 2; // sim seconds per ripple / breath
const GLOW_ALPHA = 0.12;
const GLOW_BREATH = 0.04; // ± around GLOW_ALPHA
const EDGE_ALPHA = 0.6;
const RIPPLE_ALPHA = 0.7;
const RIPPLE_START = 0.55; // ripple starts at this fraction of the radius
// By Faction: friendly orange-gold; enemy cyan, matching the battle-mode enemy hero color
const COLORS = ['255, 160, 0', '0, 229, 255'];
const EDGE_COLORS = COLORS.map((c) => `rgba(${c}, ${EDGE_ALPHA})`);

export class HeroAura {
  // heroes: this frame's heroes (other units are skipped)
  draw(
    ctx: CanvasRenderingContext2D,
    heroes: readonly IUnit[],
    camera: Camera,
    width: number,
    height: number,
    simTime: number
  ): void {
    const phase = (simTime % PULSE_PERIOD) / PULSE_PERIOD; // 0..1, shared by all heroes
    for (let i = 0; i < heroes.length; i++) {
      if (heroes[i].unitType !== UnitType.HERO) continue;
      this.drawOne(ctx, heroes[i] as IHero, camera, width, height, phase);
    }
  }

  private drawOne(
    ctx: CanvasRenderingContext2D,
    hero: IHero,
    camera: Camera,
    width: number,
    height: number,
    phase: number
  ): void {
    const { x: camX, y: camY, zoom } = camera;
    const cx = (hero.position.x - camX) * zoom;
    const cy = (hero.position.y - camY) * zoom;
    const r = hero.charismaRadius * zoom;
    if (cx + r < 0 || cx - r > width || cy + r < 0 || cy - r > height) return;

    const side = hero.faction === Faction.ENEMY ? 1 : 0;
    const color = COLORS[side];
    const line = Math.max(1.5, zoom * 0.15);

    // Breathing glow over the whole radius
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color}, ${GLOW_ALPHA + GLOW_BREATH * Math.sin(phase * Math.PI * 2)})`;
    ctx.fill();

    // Steady edge marking the exact radius
    ctx.lineWidth = line;
    ctx.strokeStyle = EDGE_COLORS[side];
    ctx.stroke();

    // Ripple: expands from RIPPLE_START·r to r while fading out
    ctx.beginPath();
    ctx.arc(cx, cy, r * (RIPPLE_START + (1 - RIPPLE_START) * phase), 0, Math.PI * 2);
    ctx.lineWidth = line * 1.5;
    ctx.strokeStyle = `rgba(${color}, ${RIPPLE_ALPHA * (1 - phase)})`;
    ctx.stroke();
  }
}
