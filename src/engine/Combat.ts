import { StateManager } from '../state/StateManager';
import { IUnit, BehaviorState } from '../types/types';
import { ATTACK_INTERVAL, REST_HEAL_PER_SEC } from './Rules';

// Rest, combat and deaths, after movement each frame.

export function processRest(units: IUnit[], deltaTime: number): void {
  for (const unit of units) {
    if (unit.state !== BehaviorState.REST) continue;
    unit.hp = Math.min(unit.maxHp, unit.hp + REST_HEAL_PER_SEC * deltaTime);
  }
}

// Damage per target id within one frame, reused
const pendingDamage = new Map<string, number>();

// Every attacker whose cooldown is over hits its target. The damage is summed first and dealt
// after all attackers have struck, so two units can kill each other in the same frame.
export function processCombat(sm: StateManager, units: IUnit[], deltaTime: number): void {
  pendingDamage.clear();

  for (const unit of units) {
    if (unit.state !== BehaviorState.ATTACK || unit.target === null) continue;

    unit.attackCooldown -= deltaTime;
    if (unit.attackCooldown > 0) continue;

    const target = sm.getUnitById(unit.target);
    if (!target || target.hp <= 0) {
      unit.target = null;
      unit.state = BehaviorState.IDLE;
      continue;
    }

    pendingDamage.set(target.id, (pendingDamage.get(target.id) ?? 0) + unit.damage);
    unit.attackCooldown = ATTACK_INTERVAL;
  }

  for (const [id, damage] of pendingDamage) {
    const target = sm.getUnitById(id);
    if (target) target.hp = Math.max(0, target.hp - damage);
  }
}

// The ids removeDeadUnits collects, reused every frame
const dead: string[] = [];

export function removeDeadUnits(sm: StateManager): void {
  dead.length = 0;
  for (const unit of sm.getBattlefield().units) {
    if (unit.hp <= 0) dead.push(unit.id);
  }
  for (const id of dead) {
    sm.removeUnit(id);
  }
}
