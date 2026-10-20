import {
  IUnit,
  IHero,
  UnitType,
  Faction,
  BehaviorState,
  Camera,
  UNIT_COLORS,
} from '../types/types';
import type { EffectsManager } from './effects/EffectsManager';
import { ENEMY_HERO_COLOR } from './SideColors';
// ATTACK_INTERVAL: attackCooldown is reset to it on each hit, which times the attack pose
import { ATTACK_INTERVAL } from '../engine/Rules';
import { UnitSprites, FRAME, COL_LEFT, COL_RIGHT, WALK_FRAMES, ROW_ATTACK } from './UnitSprites';

// Attack pose: the sprite leans this far toward its facing side, as a share of its size
const ATTACK_LUNGE = 0.12;
// Sprite animation
const WALK_FPS = 8;
// The attack frame is shown for this long after each hit
const ATTACK_POSE_TIME = 0.25;
const HERO_RING_COLORS = ['#FFD700', ENEMY_HERO_COLOR]; // by Faction
// Square colours (FX off) indexed by UnitType
const SQUARE_COLORS = [UNIT_COLORS.WARRIOR, UNIT_COLORS.HERO, UNIT_COLORS.BERSERKER];

// The units and the bars over them, on the main view. Every pass draws the soldiers first and
// then the heroes, so a hero stays visible (and clickable to the eye) when its soldiers crowd
// around it. The heroes are collected once per frame (collectHeroes()), so a pass is one loop
// over the soldiers plus a few heroes rather than two loops over every unit.
export class UnitLayer {
  // This frame's heroes, in the order of the unit list (reused array)
  readonly heroes: IUnit[] = [];

  constructor(
    private effects: EffectsManager,
    private sprites: UnitSprites
  ) {}

  // Call once per frame, before anything is drawn
  collectHeroes(units: readonly IUnit[]): void {
    const heroes = this.heroes;
    heroes.length = 0;
    for (let i = 0; i < units.length; i++) {
      if (units[i].unitType === UnitType.HERO) heroes.push(units[i]);
    }
  }

  // FX off: the original squares (white while hit, heroes outlined). FX on with the sprites
  // loaded: sprites at every zoom and with no limit on how many are in view.
  drawUnits(
    ctx: CanvasRenderingContext2D,
    units: readonly IUnit[],
    camera: Camera,
    width: number,
    height: number,
    spriteMode: boolean
  ): void {
    if (spriteMode) this.drawSprites(ctx, units, camera, width, height);
    else this.drawSquares(ctx, units, camera, width, height);
  }

  private drawSquares(
    ctx: CanvasRenderingContext2D,
    units: readonly IUnit[],
    camera: Camera,
    width: number,
    height: number
  ): void {
    const { x: camX, y: camY, zoom } = camera;
    const size = Math.max(3, zoom * 2);
    const half = size / 2;
    const now = performance.now();
    const anyFlash = this.effects.hasFlashes();
    const heroes = this.heroes;
    const n = units.length;
    // Neighbours mostly share a colour: fillStyle is set only when it changes
    let fill = '';
    let outline = false;

    // Soldiers (i < n, heroes skipped), then the heroes
    for (let i = 0, end = n + heroes.length; i < end; i++) {
      const unit = i < n ? units[i] : heroes[i - n];
      const hero = unit.unitType === UnitType.HERO;
      if (hero && i < n) continue;
      const sx = (unit.position.x - camX) * zoom - half;
      const sy = (unit.position.y - camY) * zoom - half;
      if (sx + size < 0 || sx > width) continue;
      if (sy + size < 0 || sy > height) continue;

      const color =
        anyFlash && this.effects.isFlashing(unit.id, now)
          ? '#ffffff'
          : hero && unit.faction === Faction.ENEMY
            ? ENEMY_HERO_COLOR
            : (SQUARE_COLORS[unit.unitType] ?? '#fff');
      if (color !== fill) {
        ctx.fillStyle = color;
        fill = color;
      }
      ctx.fillRect(sx, sy, size, size);

      if (hero) {
        if (!outline) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          outline = true;
        }
        ctx.strokeRect(sx, sy, size, size);
      }
    }
  }

  private drawSprites(
    ctx: CanvasRenderingContext2D,
    units: readonly IUnit[],
    camera: Camera,
    width: number,
    height: number
  ): void {
    const { x: camX, y: camY, zoom } = camera;
    const size = zoom * 2;
    const half = size / 2;
    const now = performance.now();
    const anyFlash = this.effects.hasFlashes();
    const simTime = this.effects.getSimTime();
    const heroes = this.heroes;
    const n = units.length;

    // Soldiers (i < n, heroes skipped), then the heroes
    for (let i = 0, end = n + heroes.length; i < end; i++) {
      const unit = i < n ? units[i] : heroes[i - n];
      const hero = unit.unitType === UnitType.HERO;
      if (hero && i < n) continue;
      const sx = (unit.position.x - camX) * zoom - half;
      const sy = (unit.position.y - camY) * zoom - half;
      if (sx + size < 0 || sx > width) continue;
      if (sy + size < 0 || sy > height) continue;

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
      const set = this.sprites.get(
        unit.unitType,
        unit.faction,
        hero ? (unit as IHero).heroIndex - 1 : 0
      );

      if (hero) {
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

  // An HP bar over each unit; units that use courage (warriors, and berserkers in battle mode)
  // also get a courage bar below it. smart (FX on, Bars button): only over units that are hurt,
  // fighting, fleeing or resting, heroes and the selected unit.
  drawBars(
    ctx: CanvasRenderingContext2D,
    units: readonly IUnit[],
    camera: Camera,
    width: number,
    height: number,
    smart: boolean,
    selectedUnitId: string | null,
    battleMode: boolean
  ): void {
    const { x: camX, y: camY, zoom } = camera;
    const barW = Math.max(6, zoom * 2);
    const hpH = Math.max(1, Math.floor(zoom * 0.4));
    const cH = Math.max(1, Math.floor(zoom * 0.25));
    const heroes = this.heroes;
    const n = units.length;

    // Soldiers (i < n, heroes skipped), then the heroes
    for (let i = 0, end = n + heroes.length; i < end; i++) {
      const unit = i < n ? units[i] : heroes[i - n];
      const hero = unit.unitType === UnitType.HERO;
      if (hero && i < n) continue;
      if (
        smart &&
        !hero &&
        unit.hp >= unit.maxHp &&
        unit.state === BehaviorState.IDLE &&
        unit.id !== selectedUnitId
      )
        continue;
      const courage =
        unit.unitType === UnitType.WARRIOR || (battleMode && unit.unitType === UnitType.BERSERKER);
      const totalH = courage ? hpH + 1 + cH : hpH;

      const sx = (unit.position.x - camX) * zoom - barW / 2;
      const sy = (unit.position.y - camY) * zoom - (zoom + totalH);
      if (sx + barW < 0 || sx > width) continue;
      if (sy + totalH < 0 || sy > height) continue;

      // A zero-width fill draws nothing, so it is skipped
      ctx.fillStyle = '#880000';
      ctx.fillRect(sx, sy, barW, hpH);
      const hpW = barW * (unit.hp / unit.maxHp);
      if (hpW > 0) {
        ctx.fillStyle = '#00cc44';
        ctx.fillRect(sx, sy, hpW, hpH);
      }

      if (courage) {
        const cy = sy + hpH + 1;
        ctx.fillStyle = '#333300';
        ctx.fillRect(sx, cy, barW, cH);
        const cW = barW * (unit.courage / 100);
        if (cW > 0) {
          ctx.fillStyle = '#ccaa00';
          ctx.fillRect(sx, cy, cW, cH);
        }
      }
    }
  }
}
