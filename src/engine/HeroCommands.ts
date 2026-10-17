import { StateManager } from '../state/StateManager';
import {
  IHero,
  HeroCommand,
  CommandSource,
  Position,
  BehaviorState,
  Faction,
  INNER_MIN,
  INNER_MAX,
} from '../types/types';
import {
  distToTileCentre,
  enemyPositionSum,
  findNearestEnemyAnywhere,
  nearestReachableTile,
  NEAR_TILE_DISTANCE,
  tileOf,
} from './UnitHelpers';
import { strayClusters, regroupTarget, regroupPoint, StrayCluster } from './Strays';
import { enemyBase } from './Objectives';
import { HERO_CRITICAL_HP_RATIO, RETREAT_SCAN, RETREAT_SECONDS } from './Rules';

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
    // Orders are compared by what they make the hero do: Jev's "follow the LLM" runs the LLM's
    // latest order, so the LLM restating that order, or Jev following the order the hero already
    // runs, is a repeat like any other
    const running = this.running(hero, hero.command);
    const next = this.running(hero, command);
    // A retreat repeated once the hero has reached its point falls back further, from the enemies
    // near it now (D39); repeated on the way, while the survival reflex is moving the hero away,
    // or where it cannot fall back any further (no enemy, the map edge), it changes nothing like
    // any repeated order
    let further: Position | null = null;
    if (
      command?.type === 'retreat' &&
      running?.type === 'retreat' &&
      hero.state !== BehaviorState.FLEE &&
      this.atRetreatPoint(hero, running)
    ) {
      const to = this.retreatPoint(hero);
      if (!running.to || to.x !== running.to.x || to.y !== running.to.y) further = to;
    }
    if (command && next && running && sameCommand(running, next) && !further) {
      // The hero already does this (e.g. Jev chose the same move a moment before, or the LLM
      // restates the order Jev follows): nothing changes, but a commander's order is still
      // remembered so Jev can follow it (D15), and a restated order keeps its age but takes the
      // commander's latest reason
      if (source === 'llm') {
        if (hero.lastLlmCommand && sameCommand(hero.lastLlmCommand, command)) {
          hero.lastLlmCommand = { ...hero.lastLlmCommand, reason: command.reason };
        } else {
          // The LLM orders what the hero already does on Jev's order: it takes over that order
          // with its point (a retreat's), so following it later sends the hero to the same place
          hero.lastLlmCommand = { ...running, reason: command.reason };
          hero.lastLlmTime = this.sm.getBattlefield().elapsedTime;
        }
        if (hero.command && hero.commandSource === 'llm')
          hero.command = { ...hero.command, reason: command.reason };
      }
      return;
    }
    // Retreat falls back a short way from the enemies, worked out once when it is given
    if (command?.type === 'retreat' && !command.to) {
      command = { ...command, to: further ?? this.retreatPoint(hero) };
    }
    if (!command && !hero.command) return;

    // D18: a new order from the user, Jev or the LLM ends the survival reflex, except below
    // HERO_CRITICAL_HP_RATIO (D47); the order still runs once the flight is over.
    if (
      command &&
      source !== 'rule' &&
      hero.state === BehaviorState.FLEE &&
      hero.hp / hero.maxHp >= HERO_CRITICAL_HP_RATIO
    ) {
      hero.state = BehaviorState.IDLE;
      hero.path = [];
      hero.reflexOverridden = true;
      hero.reflexOverriddenAt = this.sm.getBattlefield().elapsedTime;
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

  // The order a command runs: Jev's "follow the LLM" runs the LLM's latest order
  private running(hero: IHero, command: HeroCommand | null): HeroCommand | null {
    return command?.type === 'continueLlm' ? hero.lastLlmCommand : command;
  }

  // The hero stands at (or next to) the point of the retreat order it runs
  private atRetreatPoint(hero: IHero, retreat: HeroCommand): boolean {
    const to = retreat.type === 'retreat' ? retreat.to : undefined;
    if (!to) return false;
    return distToTileCentre(hero.position, to) <= NEAR_TILE_DISTANCE;
  }

  // Where a retreat order goes: as far as the hero walks in RETREAT_SECONDS, away from the
  // enemies near the hero (from the nearest enemy anywhere when none is near); the hero's own
  // tile when there is no enemy.
  // It used to be the start position, often more than 100 tiles away.
  private retreatPoint(hero: IHero): Position {
    let { x: ex, y: ey, n } = enemyPositionSum(this.sm, hero, RETREAT_SCAN);
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
      x: Math.max(INNER_MIN, Math.min(INNER_MAX, hero.position.x + (dx / len) * step)),
      y: Math.max(INNER_MIN, Math.min(INNER_MAX, hero.position.y + (dy / len) * step)),
    };
    return nearestReachableTile(this.sm, to);
  }

  // Re-evaluated every frame because some targets move (nearest enemy, an enemy hero).
  applyAll(): void {
    for (const hero of this.sm.getHeroes()) {
      if (hero.hp <= 0) continue;
      hero.taskPoint = this.target(hero, this.running(hero, hero.command));
    }
  }

  // Orders that send the hero somewhere: move, retreat, regroup, attack base, or resuming one of
  // the LLM's.
  private isMovement(hero: IHero, command: HeroCommand): boolean {
    const c = this.running(hero, command);
    return (
      c?.type === 'move' ||
      c?.type === 'retreat' ||
      c?.type === 'regroup' ||
      c?.type === 'attackBase'
    );
  }

  // null means "no destination": the hero stays where it is. Units can stand on a tile A* treats
  // as blocked (next to a mountain, after cutting a path's corner); a target on one would leave
  // the hero without a path, so targets that follow units are snapped to the nearest reachable
  // tile, like move orders.
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
        return enemy ? nearestReachableTile(this.sm, enemy.position) : null;
      }
      case 'attackHero': {
        const target = this.sm
          .getHeroes()
          .find((h) => h.faction !== hero.faction && h.heroIndex === command.heroIndex && h.hp > 0);
        const enemy = target ?? findNearestEnemyAnywhere(this.sm, hero); // target dead: nearest enemy
        return enemy ? nearestReachableTile(this.sm, enemy.position) : null;
      }
      case 'regroup': {
        const cluster = regroupTarget(this.straysOf(hero.faction), hero);
        return cluster ? nearestReachableTile(this.sm, regroupPoint(cluster, hero)) : null; // no strays: stay
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
