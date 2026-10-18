import { StateManager } from '../state/StateManager';
import { BehaviorState, HeroCommand, IHero, UnitType } from '../types/types';
import { effectiveSight, nearestReachableTile } from './UnitHelpers';
import { HERO_BEHIND_HOLD_SECONDS, HERO_BEHIND_MIN_SOLDIERS, HERO_BEHIND_TILES } from './Rules';

// D48 (battle mode): a hero stays behind its soldiers while enemies are near. Its group keeps
// going to the order's point (taskPoint, like the "virtual leader" of squad formations); the
// hero walks to a point HERO_BEHIND_TILES behind the middle of its soldiers on the side away
// from the middle of the enemies (Reynolds' "hide" behind its own army). Heroes walked on into
// the enemy while their soldiers stopped to fight, and died in seconds in big battles. Orders
// that put the hero in front: attack, attack_hero and attack_base (it fights), and retreat (it
// falls back anyway). The AI layers choose between lead (soldiers charge, hero behind) and
// attack (hero charges too).

const IN_FRONT = new Set<HeroCommand['type']>(['attack', 'attackHero', 'attackBase', 'retreat']);

export function updateHeroStand(
  sm: StateManager,
  hero: IHero,
  command: HeroCommand | null,
  now: number
): void {
  if (hero.hp <= 0 || !command || IN_FRONT.has(command.type) || hero.state === BehaviorState.FLEE) {
    hero.standPoint = null;
    hero.standUntil = 0;
    return;
  }
  let ex = 0;
  let ey = 0;
  let enemies = 0;
  let sx = 0;
  let sy = 0;
  let soldiers = 0;
  sm.forEachInRadius(hero.position.x, hero.position.y, effectiveSight(sm, hero), (u) => {
    if (u.hp <= 0 || u === hero) return;
    if (u.faction !== hero.faction) {
      ex += u.position.x;
      ey += u.position.y;
      enemies++;
    } else if (u.unitType !== UnitType.HERO && u.state !== BehaviorState.FLEE) {
      sx += u.position.x;
      sy += u.position.y;
      soldiers++;
    }
  });
  if (enemies > 0) hero.standUntil = now + HERO_BEHIND_HOLD_SECONDS;
  if (now >= hero.standUntil || soldiers < HERO_BEHIND_MIN_SOLDIERS) {
    hero.standPoint = null;
    return;
  }
  // The enemies just left its sight: it keeps its place a moment, so it does not flicker
  if (enemies === 0) return;
  const cx = sx / soldiers;
  const cy = sy / soldiers;
  const dx = cx - ex / enemies;
  const dy = cy - ey / enemies;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const tile = nearestReachableTile(sm, {
    x: cx + (dx / len) * HERO_BEHIND_TILES,
    y: cy + (dy / len) * HERO_BEHIND_TILES,
  });
  hero.standPoint = { x: tile.x + 0.5, y: tile.y + 0.5 };
}
