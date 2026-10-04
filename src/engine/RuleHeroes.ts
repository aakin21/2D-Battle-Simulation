import { StateManager } from '../state/StateManager';
import { BehaviorState, IHero } from '../types/types';
import { HeroCommands } from './HeroCommands';
import { GroupPatrol } from './GroupPatrol';
import { findNearestEnemy } from './UnitHelpers';

const ARRIVE_RADIUS = 2;

// Rule heroes whose survival reflex is running; kept per hero object, so a restart forgets them.
const fled = new WeakSet<IHero>();

// Rule-controlled heroes (battle mode, no AI): attack when an enemy is in sight, otherwise
// patrol like a berserker group. Orders go through the command interface like any other.
export function updateRuleHeroes(
  sm: StateManager,
  commands: HeroCommands,
  patrol: GroupPatrol
): void {
  const elapsed = sm.getBattlefield().elapsedTime;
  for (const hero of sm.getHeroes()) {
    if (hero.controller !== 'rule' || hero.hp <= 0) continue;
    if (hero.state === BehaviorState.FLEE) {
      fled.add(hero);
      continue;
    }
    // D18: after a flight a rule hero rests until its HP is full, so it does not walk
    // straight back into the fight. An enemy coming into sight ends the rest (engine rule).
    if (fled.has(hero)) {
      fled.delete(hero);
      if (hero.hp < hero.maxHp && !findNearestEnemy(sm, hero)) {
        hero.state = BehaviorState.REST;
        hero.target = null;
        hero.path = [];
      }
    }
    if (hero.state === BehaviorState.REST) continue;

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
