import { StateManager } from '../state/StateManager';
import { IHero, IUnit, BehaviorState, TerrainType } from '../types/types';
import { effectiveSight, stepToward } from './UnitHelpers';
import {
  HERO_RETREAT_HP_RATIO as RETREAT_HP_RATIO,
  HERO_RECOVER_HP_RATIO as RECOVER_HP_RATIO,
  HERO_OUTNUMBERED_MIN_ENEMIES as OUTNUMBERED_MIN_ENEMIES,
  HERO_OUTNUMBERED_RATIO as OUTNUMBERED_RATIO,
} from './Rules';

// D18 hero survival reflex (battle mode). Rules come first: whatever the hero was ordered,
// it falls back when badly hurt or heavily outnumbered, and resumes once it has recovered.
const HOME_RADIUS = 2;

// Returns true when the reflex decided the hero's state this frame.
export function updateHeroReflex(sm: StateManager, hero: IUnit): boolean {
  let allies = 0;
  let enemies = 0;
  sm.forEachInRadius(hero.position.x, hero.position.y, effectiveSight(sm, hero), (other) => {
    if (other.hp <= 0 || other.id === hero.id) return;
    if (other.faction === hero.faction) allies++;
    else enemies++;
  });

  const outnumbered = enemies >= OUTNUMBERED_MIN_ENEMIES && enemies >= OUTNUMBERED_RATIO * allies;
  const hpRatio = hero.hp / hero.maxHp;

  if (hero.state === BehaviorState.FLEE) {
    if (enemies === 0 || (hpRatio >= RECOVER_HP_RATIO && !outnumbered)) {
      hero.state = BehaviorState.IDLE;
      hero.target = null;
      hero.path = [];
      return false;
    }
    return true;
  }

  if (enemies > 0 && (hpRatio < RETREAT_HP_RATIO || outnumbered)) {
    hero.state = BehaviorState.FLEE;
    hero.target = null;
    hero.path = [];
    return true;
  }
  return false;
}

// Retreating hero moves away from the enemies around it and back toward its own side
// (its start position). Running to its soldiers' centre is not safe: they may be
// fighting in the middle of the enemy.
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

  let dx = 0;
  let dy = 0;
  if (n > 0) {
    const ax = hero.position.x - ex / n;
    const ay = hero.position.y - ey / n;
    const al = Math.hypot(ax, ay) || 1;
    dx += ax / al;
    dy += ay / al;
  }
  const hx = hero.home.x + 0.5 - hero.position.x;
  const hy = hero.home.y + 0.5 - hero.position.y;
  const hl = Math.hypot(hx, hy);
  if (hl > HOME_RADIUS) {
    dx += hx / hl;
    dy += hy / hl;
  }

  if (dx === 0 && dy === 0) return; // safe at home
  stepToward(sm, hero, Math.atan2(dy, dx), deltaTime, grid);
}
