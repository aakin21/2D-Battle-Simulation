import { StateManager } from '../state/StateManager';
import { IUnit, IHero, UnitType, BehaviorState } from '../types/types';
import {
  COMBAT_RANGE,
  FLEE_THRESHOLD,
  RALLY_COURAGE,
  REST_TRIGGER_HP,
  HERO_REST_TRIGGER_HP,
  DISENGAGE_CLEAR_RADIUS,
} from './Rules';
import { updateHeroReflex } from './HeroReflex';
import { distToTileCentre, findNearestEnemy, NEAR_TILE_DISTANCE } from './UnitHelpers';
import { charismaReach, findLeader, isSoldier } from './Soldiers';

// Each unit's state for this frame (IDLE → ATTACK → FLEE → REST): the hero reflex (D18), flight
// on low courage, rest, breaking off a fight (D27), and attacking the nearest enemy in range.

export function updateBehavior(sm: StateManager, unit: IUnit, battleMode: boolean): void {
  if (battleMode && unit.unitType === UnitType.HERO && updateHeroReflex(sm, unit as IHero)) return;

  if (unit.unitType === UnitType.BERSERKER && !battleMode) {
    attackOrIdle(unit, findNearestEnemy(sm, unit), true);
    return;
  }

  const enemy = findNearestEnemy(sm, unit);
  const soldier = isSoldier(unit, battleMode);

  if (unit.state === BehaviorState.FLEE) {
    // Battle mode (D57, a rout): a flight lasts until no enemy is in sight, or until one of the
    // soldier's heroes is near and its courage is back to RALLY_COURAGE; it used to end as soon as
    // courage rose above the threshold, a step back into its own ranks, and the soldier flipped
    // between fleeing and fighting many times a second. Classic mode keeps that rule (D19).
    const over =
      battleMode && soldier
        ? !enemy ||
          (unit.courage >= RALLY_COURAGE && findLeader(sm, unit, charismaReach) !== undefined)
        : !enemy || unit.courage > FLEE_THRESHOLD;
    if (over) {
      unit.state = BehaviorState.IDLE;
      unit.target = null;
      unit.path = [];
    }
    return;
  }

  if (unit.state === BehaviorState.REST) {
    if (enemy || unit.hp >= unit.maxHp || calledAway(unit, battleMode)) {
      unit.state = BehaviorState.IDLE;
      unit.target = null;
    }
    return;
  }

  if (soldier && enemy && unit.courage <= FLEE_THRESHOLD) {
    unit.state = BehaviorState.FLEE;
    unit.target = null;
    unit.path = [];
    return;
  }

  if (
    (soldier || unit.unitType === UnitType.HERO) &&
    unit.hp < restBelow(unit, battleMode) &&
    !enemy &&
    !onTheWay(unit, battleMode)
  ) {
    unit.state = BehaviorState.REST;
    unit.target = null;
    unit.path = [];
    return;
  }

  if (unit.unitType === UnitType.HERO) {
    // D27: a hero breaking off a fight walks on without engaging until it is clear of
    // enemies, then behaves normally again (so it does not march into the next group).
    const hero = unit as IHero;
    // Breaking off means walking on without fighting; a hero that has reached its point has
    // nowhere to walk on to, so it fights there (a retreat: "the fight goes on there")
    if (hero.disengaging && !onTheWay(hero, battleMode)) hero.disengaging = false;
    if (hero.disengaging) {
      if (
        sm.hasEnemyInRadius(hero.position.x, hero.position.y, DISENGAGE_CLEAR_RADIUS, hero.faction)
      ) {
        hero.state = BehaviorState.IDLE;
        hero.target = null;
        return;
      }
      hero.disengaging = false;
    }
    attackOrIdle(unit, enemy, false);
    return;
  }

  attackOrIdle(unit, enemy, true);
}

// Attack the enemy if it is within COMBAT_RANGE, otherwise stay IDLE. keepTarget: an enemy
// out of range stays the target, so the unit moves toward it (heroes follow their task point).
export function attackOrIdle(unit: IUnit, enemy: IUnit | null, keepTarget: boolean): void {
  if (enemy) {
    const dx = enemy.position.x - unit.position.x;
    const dy = enemy.position.y - unit.position.y;
    if (dx * dx + dy * dy <= COMBAT_RANGE * COMBAT_RANGE) {
      unit.state = BehaviorState.ATTACK;
      unit.target = enemy.id;
      unit.path = [];
      return;
    }
  }
  unit.state = BehaviorState.IDLE;
  unit.target = enemy && keepTarget ? enemy.id : null;
}

// Rest (D45): in battle mode a hero rests below HERO_REST_TRIGGER_HP whenever it stands still
// with no enemy in sight; other units, and heroes in classic mode, below REST_TRIGGER_HP.
function restBelow(unit: IUnit, battleMode: boolean): number {
  return battleMode && unit.unitType === UnitType.HERO ? HERO_REST_TRIGGER_HP : REST_TRIGGER_HP;
}

// A battle-mode hero with somewhere to go: a task point more than a tile and a half away
function onTheWay(unit: IUnit, battleMode: boolean): boolean {
  if (!battleMode || unit.unitType !== UnitType.HERO) return false;
  const p = (unit as IHero).taskPoint;
  if (!p) return false;
  return distToTileCentre(unit.position, p) > NEAR_TILE_DISTANCE;
}

// A resting hero of the user, Jev or the LLM stops as soon as an order sends it somewhere, so
// orders never wait for a rest (D45). Rule heroes keep resting until healed after a flight (D18).
function calledAway(unit: IUnit, battleMode: boolean): boolean {
  return (unit as IHero).controller !== 'rule' && onTheWay(unit, battleMode);
}
