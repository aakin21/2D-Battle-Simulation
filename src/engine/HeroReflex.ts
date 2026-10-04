import { StateManager } from '../state/StateManager';
import { IHero, BehaviorState, TerrainType } from '../types/types';
import { effectiveSight, stepToward } from './UnitHelpers';
import {
  HERO_RETREAT_HP_RATIO as RETREAT_HP_RATIO,
  HERO_OUTNUMBERED_MIN_ENEMIES as OUTNUMBERED_MIN_ENEMIES,
  HERO_OUTNUMBERED_RATIO as OUTNUMBERED_RATIO,
} from './Rules';

// D18 hero survival reflex (battle mode). A hero that is badly hurt or heavily outnumbered
// with enemies in sight moves away from them until none is in sight. A different order from
// the user, Jev or the LLM ends the flight; the reflex then stays off until the hero's sight
// is clear once (see HeroCommands.issue).

// Returns true when the reflex decided the hero's state this frame.
export function updateHeroReflex(sm: StateManager, hero: IHero): boolean {
  let allies = 0;
  let enemies = 0;
  sm.forEachInRadius(hero.position.x, hero.position.y, effectiveSight(sm, hero), (other) => {
    if (other.hp <= 0 || other.id === hero.id) return;
    if (other.faction === hero.faction) allies++;
    else enemies++;
  });

  if (hero.reflexOverridden) {
    if (enemies === 0) hero.reflexOverridden = false;
    return false;
  }

  if (hero.state === BehaviorState.FLEE) {
    if (enemies === 0) {
      hero.state = BehaviorState.IDLE;
      hero.target = null;
      hero.path = [];
      return false;
    }
    return true;
  }

  const outnumbered = enemies >= OUTNUMBERED_MIN_ENEMIES && enemies >= OUTNUMBERED_RATIO * allies;
  if (enemies > 0 && (hero.hp / hero.maxHp < RETREAT_HP_RATIO || outnumbered)) {
    hero.state = BehaviorState.FLEE;
    hero.target = null;
    hero.path = [];
    return true;
  }
  return false;
}

// A fleeing hero moves straight away from the enemies it sees. It does not run home and it
// sets no task point, so its soldiers keep their fight.
export function moveHeroRetreat(
  sm: StateManager,
  hero: IHero,
  deltaTime: number,
  grid: TerrainType[][]
): void {
  let ex = 0;
  let ey = 0;
  let n = 0;
  sm.forEachInRadius(hero.position.x, hero.position.y, effectiveSight(sm, hero), (other) => {
    if (other.hp <= 0 || other.faction === hero.faction) return;
    ex += other.position.x;
    ey += other.position.y;
    n++;
  });
  if (n === 0) return;
  const ax = hero.position.x - ex / n;
  const ay = hero.position.y - ey / n;
  if (ax === 0 && ay === 0) return;
  stepToward(sm, hero, Math.atan2(ay, ax), deltaTime, grid);
}
