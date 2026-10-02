import { StateManager } from '../state/StateManager';
import { IHero, HeroCommand, CommandSource, Position } from '../types/types';
import { findNearestEnemyAnywhere, nearestReachableTile, tileOf } from './UnitHelpers';

// The command interface (D20). Every order — user click, rule hero, Jev, LLM — goes through
// issue(), so a hero behaves the same whoever gave it. Each frame applyAll() turns each
// hero's command into the task point it walks to.
export class HeroCommands {
  constructor(private sm: StateManager) {}

  issue(hero: IHero, command: HeroCommand | null, source: CommandSource): void {
    if (command?.type === 'move') {
      command = { type: 'move', target: nearestReachableTile(this.sm, command.target) };
    }
    hero.command = command;
    hero.commandSource = command ? source : null;
    hero.commandTime = this.sm.getBattlefield().elapsedTime;
    if (source === 'llm' && command) hero.lastLlmCommand = command;
  }

  // Re-evaluated every frame because some targets move (nearest enemy, an enemy hero).
  applyAll(): void {
    for (const hero of this.sm.getHeroes()) {
      if (hero.hp <= 0) continue;
      const command = hero.command?.type === 'continueLlm' ? hero.lastLlmCommand : hero.command;
      hero.taskPoint = this.target(hero, command);
    }
  }

  // null means "no destination": the hero stays where it is.
  private target(hero: IHero, command: HeroCommand | null): Position | null {
    if (!command) return null;
    switch (command.type) {
      case 'move':
        return command.target;
      case 'hold':
        return command.at;
      case 'retreat':
        return hero.home;
      case 'attack': {
        const enemy = findNearestEnemyAnywhere(this.sm, hero);
        return enemy ? tileOf(enemy.position) : null;
      }
      case 'attackHero': {
        const target = this.sm
          .getHeroes()
          .find((h) => h.faction !== hero.faction && h.heroIndex === command.heroIndex && h.hp > 0);
        const enemy = target ?? findNearestEnemyAnywhere(this.sm, hero); // target dead: nearest enemy
        return enemy ? tileOf(enemy.position) : null;
      }
      case 'continueLlm':
        return null; // no LLM command yet
    }
  }
}
