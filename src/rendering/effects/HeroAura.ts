import { Camera, IHero, IUnit, UnitType } from '../../types/types';

// A soft pulsing aura around the hero showing its charisma radius — the area in
// which warriors get the courage bonus (SimulationEngine uses hero.charismaRadius).
// A faint glow breathes, and a ripple ring expands toward the edge and fades.
// Only one hero exists, so this costs a handful of draw calls. Sim time drives the
// animation, so it freezes on pause.

const PULSE_PERIOD = 2; // sim seconds per ripple / breath
const GLOW_ALPHA = 0.12;
const GLOW_BREATH = 0.04; // ± around GLOW_ALPHA
const EDGE_ALPHA = 0.6;
const RIPPLE_ALPHA = 0.7;
const RIPPLE_START = 0.55; // ripple starts at this fraction of the radius
const COLOR = '255, 160, 0';

export class HeroAura {
  draw(
    ctx: CanvasRenderingContext2D,
    units: IUnit[],
    camera: Camera,
    width: number,
    height: number,
    simTime: number
  ): void {
    const hero = units.find((u) => u.unitType === UnitType.HERO) as IHero | undefined;
    if (!hero) return;

    const { x: camX, y: camY, zoom } = camera;
    const cx = (hero.position.x - camX) * zoom;
    const cy = (hero.position.y - camY) * zoom;
    const r = hero.charismaRadius * zoom;
    if (cx + r < 0 || cx - r > width || cy + r < 0 || cy - r > height) return;

    const phase = (simTime % PULSE_PERIOD) / PULSE_PERIOD; // 0..1
    const line = Math.max(1.5, zoom * 0.15);

    // Breathing glow over the whole radius
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${COLOR}, ${GLOW_ALPHA + GLOW_BREATH * Math.sin(phase * Math.PI * 2)})`;
    ctx.fill();

    // Steady edge marking the exact radius
    ctx.lineWidth = line;
    ctx.strokeStyle = `rgba(${COLOR}, ${EDGE_ALPHA})`;
    ctx.stroke();

    // Ripple: expands from RIPPLE_START·r to r while fading out
    ctx.beginPath();
    ctx.arc(cx, cy, r * (RIPPLE_START + (1 - RIPPLE_START) * phase), 0, Math.PI * 2);
    ctx.lineWidth = line * 1.5;
    ctx.strokeStyle = `rgba(${COLOR}, ${RIPPLE_ALPHA * (1 - phase)})`;
    ctx.stroke();
  }
}
