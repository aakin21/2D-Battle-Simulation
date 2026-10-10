import { StateManager } from '../state/StateManager';
import {
  IHero,
  HeroCommand,
  CommandSource,
  Position,
  BehaviorState,
  Faction,
  GRID_SIZE,
} from '../types/types';
import { findNearestEnemyAnywhere, nearestReachableTile, tileOf } from './UnitHelpers';
import { strayClusters, regroupTarget, StrayCluster } from './Strays';
import { enemyBase } from './Objectives';
import { RETREAT_SCAN, RETREAT_SECONDS } from './Rules';

const STRAY_CACHE_SEC = 0.5; // stray clusters are recomputed at most this often

// The command interface (D20). Every order — user click, rule hero, Jev, LLM — goes through
// issue(), so a hero behaves the same whoever gave it. Each frame applyAll() turns each
// hero's command into the task point it walks to.
export class HeroCommands {
  private strayCache = new Map<Faction, { time: number; clusters: StrayCluster[] }>();

  constructor(private sm: StateManager) {}

  private straysOf(faction: Faction): StrayCluster[] {
    const now = this.sm.getBattlefield().elapsedTime;
    const cached = this.strayCache.get(faction);
    if (cached && now - cached.time < STRAY_CACHE_SEC && now >= cached.time) return cached.clusters;
    const clusters = strayClusters(this.sm, faction);
    this.strayCache.set(faction, { time: now, clusters });
    return clusters;
  }

  // breakOffAllowed (battle mode, D27): a *different* movement order given while the hero is
  // fighting makes it break off the fight; retreat always does. A repeated order is not a new
  // decision (the LLM restates its orders every report), so it changes nothing.
  issue(
    hero: IHero,
    command: HeroCommand | null,
    source: CommandSource,
    breakOffAllowed = false
  ): void {
    // A point that is not a number cannot be reached: the order is ignored (no source makes
    // one today, but a bad one would leave the hero with a NaN task point)
    if (command && !finitePoint(command)) return;
    if (command?.type === 'move') {
      command = { ...command, target: nearestReachableTile(this.sm, command.target) };
    }
    if (command && hero.command && sameCommand(hero.command, command)) {
      // The hero already does this (e.g. Jev chose the same move a moment before): nothing
      // changes, but a commander's order is still remembered so Jev can follow it (D15), and
      // a restated order keeps its age but takes the commander's latest reason
      if (source === 'llm') {
        if (hero.lastLlmCommand && sameCommand(hero.lastLlmCommand, command)) {
          hero.lastLlmCommand = { ...hero.lastLlmCommand, reason: command.reason };
        } else {
          hero.lastLlmCommand = command;
          hero.lastLlmTime = this.sm.getBattlefield().elapsedTime;
        }
        if (hero.commandSource === 'llm')
          hero.command = { ...hero.command, reason: command.reason };
      }
      return;
    }
    // Retreat falls back a short way from the enemies, worked out once when it is given
    if (command?.type === 'retreat' && !command.to) {
      command = { ...command, to: this.retreatPoint(hero) };
    }
    if (!command && !hero.command) return;

    // D18: a new order from the user, Jev or the LLM ends the survival reflex.
    if (command && source !== 'rule' && hero.state === BehaviorState.FLEE) {
      hero.state = BehaviorState.IDLE;
      hero.path = [];
      hero.reflexOverridden = true;
    }

    hero.command = command;
    hero.commandSource = command ? source : null;
    hero.commandTime = this.sm.getBattlefield().elapsedTime;
    if (source === 'llm' && command) {
      hero.lastLlmCommand = command;
      hero.lastLlmTime = hero.commandTime;
    }

    const movement = command !== null && this.isMovement(hero, command);
    hero.disengaging =
      breakOffAllowed &&
      movement &&
      (command?.type === 'retreat' || hero.state === BehaviorState.ATTACK);
  }

  // Where a retreat order goes: as far as the hero walks in RETREAT_SECONDS, away from the
  // enemies near the hero (from the nearest enemy anywhere when none is near); the hero's own
  // tile when there is no enemy.
  // It used to be the start position, often more than 100 tiles away.
  private retreatPoint(hero: IHero): Position {
    let ex = 0;
    let ey = 0;
    let n = 0;
    this.sm.forEachInRadius(hero.position.x, hero.position.y, RETREAT_SCAN, (u) => {
      if (u.hp <= 0 || u.faction === hero.faction) return;
      ex += u.position.x;
      ey += u.position.y;
      n++;
    });
    if (n === 0) {
      const enemy = findNearestEnemyAnywhere(this.sm, hero);
      if (!enemy) return tileOf(hero.position);
      ex = enemy.position.x;
      ey = enemy.position.y;
      n = 1;
    }
    const dx = hero.position.x - ex / n;
    const dy = hero.position.y - ey / n;
    const len = Math.hypot(dx, dy) || 1;
    const step = hero.baseSpeed * RETREAT_SECONDS;
    const to = {
      x: Math.max(1, Math.min(GRID_SIZE - 2, hero.position.x + (dx / len) * step)),
      y: Math.max(1, Math.min(GRID_SIZE - 2, hero.position.y + (dy / len) * step)),
    };
    return nearestReachableTile(this.sm, to);
  }

  // Re-evaluated every frame because some targets move (nearest enemy, an enemy hero).
  applyAll(): void {
    for (const hero of this.sm.getHeroes()) {
      if (hero.hp <= 0) continue;
      const command = hero.command?.type === 'continueLlm' ? hero.lastLlmCommand : hero.command;
      hero.taskPoint = this.target(hero, command);
    }
  }

  // Orders that send the hero somewhere: move, retreat, or resuming an LLM move/retreat.
  private isMovement(hero: IHero, command: HeroCommand): boolean {
    const c = command.type === 'continueLlm' ? hero.lastLlmCommand : command;
    return (
      c?.type === 'move' ||
      c?.type === 'retreat' ||
      c?.type === 'regroup' ||
      c?.type === 'attackBase'
    );
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
        return command.to ?? hero.home;
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
      case 'regroup': {
        const cluster = regroupTarget(this.straysOf(hero.faction), hero);
        return cluster ? tileOf(cluster.center) : null; // no strays: stay
      }
      case 'attackBase': {
        const base = enemyBase(this.sm, hero.faction);
        return base && base.hp > 0 ? base.position : null;
      }
      case 'continueLlm':
        return null; // no LLM command yet
    }
  }
}

// Two orders are the same if they would send the hero to the same place in the same way.
// A repeated hold keeps the original hold position.
export function sameCommand(a: HeroCommand, b: HeroCommand): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'move' && b.type === 'move') {
    return a.target.x === b.target.x && a.target.y === b.target.y;
  }
  if (a.type === 'attackHero' && b.type === 'attackHero') return a.heroIndex === b.heroIndex;
  return true;
}

function finitePoint(command: HeroCommand): boolean {
  const p = command.type === 'move' ? command.target : command.type === 'hold' ? command.at : null;
  return !p || (Number.isFinite(p.x) && Number.isFinite(p.y));
}
