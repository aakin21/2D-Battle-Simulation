import { StateManager } from '../state/StateManager';
import { BehaviorState } from '../types/types';
import { HeroCommands } from './HeroCommands';
import { GroupPatrol } from './GroupPatrol';
import { findNearestEnemy } from './UnitHelpers';

const ARRIVE_RADIUS = 2;

// Rule-controlled heroes (battle mode, no AI): attack when an enemy is in sight, otherwise
// patrol like a berserker group. Orders go through the command interface like any other.
export function updateRuleHeroes(
  sm: StateManager,
  commands: HeroCommands,
  patrol: GroupPatrol
): void {
  const elapsed = sm.getBattlefield().elapsedTime;
  for (const hero of sm.getHeroes()) {
    if (hero.controller !== 'rule' || hero.hp <= 0 || hero.state === BehaviorState.FLEE) continue;

    if (findNearestEnemy(sm, hero)) {
      if (hero.command?.type !== 'attack') commands.issue(hero, { type: 'attack' }, 'rule');
      continue;
    }

    const objective = sm.getBattlefield().objective;
    if (objective.mode === 'control' && objective.points.length > 0) {
      // Hero 1 takes A, hero 2 takes B, others go to the point their side is not holding.
      const points = objective.points;
      const point =
        hero.heroIndex <= points.length
          ? points[hero.heroIndex - 1]
          : (points.find((p) => p.holder !== hero.faction) ?? points[0]);
      commands.issue(hero, { type: 'move', target: point.position }, 'rule');
      continue;
    }
    if (objective.mode === 'base' && objective.bases.some((b) => b.faction !== hero.faction)) {
      commands.issue(hero, { type: 'attackBase' }, 'rule');
      continue;
    }

    const key = `hero_${hero.id}`;
    const dest = patrol.destination(key, hero.position, elapsed);
    const dx = dest.x - hero.position.x;
    const dy = dest.y - hero.position.y;
    if (dx * dx + dy * dy <= ARRIVE_RADIUS * ARRIVE_RADIUS) patrol.forget(key);

    const current = hero.command;
    if (current?.type !== 'move' || current.target.x !== dest.x || current.target.y !== dest.y) {
      commands.issue(hero, { type: 'move', target: dest }, 'rule');
    }
  }
}
