import { positionToSubsector } from '../engine/Sectors';
import { BehaviorState, HeroCommand, IHero } from '../types/types';

// How both layers word a hero's order and what it is doing. The LLM's wording of an order is
// shorter and names it as its own orders do ("move D4-NE", "hold in D4"); Jev reads it as a
// sentence ("move to D4-NE", "hold position in D4").

export function describeCommand(c: HeroCommand, wording: 'jev' | 'llm'): string {
  const llm = wording === 'llm';
  switch (c.type) {
    case 'move':
      return `${llm ? 'move' : 'move to'} ${positionToSubsector(c.target)}`;
    case 'hold':
      return `${llm ? 'hold in' : 'hold position in'} ${positionToSubsector(c.at)}`;
    case 'retreat':
      return 'retreat a short way from the enemies';
    case 'attack':
      return llm ? 'attack nearest enemy in sight' : 'attack the nearest enemy in sight';
    case 'lead':
      return 'lead the soldiers at the nearest enemy in sight';
    case 'attackHero':
      return `attack enemy hero ${c.heroIndex}`;
    case 'regroup':
      return 'regroup stray soldiers';
    case 'attackBase':
      return 'attack the enemy base';
    case 'continueLlm':
      return "follow the commander's order";
  }
}

// What a hero is doing now; Jev is told why a resting hero rests ("resting to heal").
export function heroStatus(hero: IHero, wording: 'jev' | 'llm'): string {
  switch (hero.state) {
    case BehaviorState.ATTACK:
      return 'fighting';
    case BehaviorState.FLEE:
      return 'retreating (survival reflex)';
    case BehaviorState.REST:
      return wording === 'llm' ? 'resting' : 'resting to heal';
    default:
      return hero.path.length > 0 ? 'moving' : 'standing';
  }
}
