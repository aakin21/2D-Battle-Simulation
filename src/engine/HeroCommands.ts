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
  attackTarget,
  findNearestEnemyAnywhere,
  nearestReachableTile,
  NEAR_TILE_DISTANCE,
  tileOf,
} from './UnitHelpers';
import { strayClusters, regroupTarget, regroupPoint, StrayCluster } from './Strays';
import { Pathfinder } from './Pathfinder';
import { enemyBase } from './Objectives';
import {
  HERO_BEHIND_TILES,
  HERO_CRITICAL_HP_RATIO,
  MAX_VIA,
  RETREAT_SCAN,
  RETREAT_SECONDS,
} from './Rules';

const STRAY_CACHE_SEC = 0.5; // stray clusters are recomputed at most this often
// A hold restated within this many tiles of the hold being run is the same order (sameCommand)
const HOLD_SAME_TILES = 2;
// D60: a via point counts as reached once the hero is this close (its soldiers crowd the point,
// and a hero behind them, D48, stands ~3.5 tiles back)
const VIA_ARRIVE_TILES = 5;
// Via points a hero remembers having reached, at most: only the ones that can still count are
// kept (keptReached), so this is a guard, far above what a route and a way around need
const VIA_REACHED_KEPT = 64;
// regroupOne (D60): the stray group it collects is the one whose centre is nearest its point and
// within this distance of it; the centre moves as soldiers join the hero
const REGROUP_ONE_TILES = 8;

// The command interface (D20). Every order — user click, rule hero, Jev, LLM — goes through
// issue(), so a hero behaves the same whoever gave it. Each frame applyAll() turns each
// hero's command into the task point it walks to.
export class HeroCommands {
  private strayCache = new Map<Faction, { time: number; clusters: StrayCluster[] }>();

  constructor(private sm: StateManager) {}

  // A new match: stray groups cached from the last one must not be used (its clock starts again)
  reset(): void {
    this.strayCache.clear();
  }

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
      const via = command.via?.slice(0, MAX_VIA).map((p) => nearestReachableTile(this.sm, p));
      command = { ...command, target: nearestReachableTile(this.sm, command.target) };
      if (via?.length) command.via = via;
      else delete command.via;
    }
    // Orders are compared by what they make the hero do: Jev's "follow the LLM" runs the LLM's
    // latest order, so the LLM restating that order, or Jev following the order the hero already
    // runs, is a repeat like any other
    const running = runningCommand(hero, hero.command);
    const next = runningCommand(hero, command);
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
      // commander's latest reason and fallback
      if (source === 'llm') {
        if (hero.lastLlmCommand && sameCommand(hero.lastLlmCommand, command)) {
          hero.lastLlmCommand = {
            ...hero.lastLlmCommand,
            reason: command.reason,
            fallback: command.fallback,
          };
        } else {
          // The LLM orders what the hero already does on Jev's order: it takes over that order
          // with its point (a retreat's), so following it later sends the hero to the same place
          hero.lastLlmCommand = { ...running, reason: command.reason, fallback: command.fallback };
          hero.lastLlmTime = this.sm.getBattlefield().elapsedTime;
        }
        if (hero.command && hero.commandSource === 'llm')
          hero.command = { ...hero.command, reason: command.reason, fallback: command.fallback };
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
    hero.attackTargetId = null; // a new order starts without the last attack's target (D55)
    hero.commandSource = command ? source : null;
    hero.commandTime = this.sm.getBattlefield().elapsedTime;
    if (source === 'llm' && command) {
      // The LLM restating its order while another one ran (Jev's) takes over as before (D15), but
      // it is no new order: it keeps its age and the via points reached since it was given, so
      // its route goes on instead of starting over
      const restated =
        hero.lastLlmCommand !== null &&
        sameCommand(hero.lastLlmCommand, command) &&
        !(running && sameCommand(running, hero.lastLlmCommand));
      hero.lastLlmCommand = command;
      if (!restated) hero.lastLlmTime = hero.commandTime;
    }

    const movement = command !== null && this.isMovement(hero, command);
    hero.disengaging =
      breakOffAllowed &&
      movement &&
      (command?.type === 'retreat' || hero.state === BehaviorState.ATTACK);
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
      const running = runningCommand(hero, hero.command);
      const effective = this.effective(hero, running);
      // The LLM's order run after a regroupOne goes on from where the LLM's route had got to
      hero.taskPoint = this.target(
        hero,
        effective,
        effective === running ? orderTime(hero) : hero.lastLlmTime
      );
    }
  }

  // The order a hero's command makes it do now: Jev's "follow the LLM" runs the LLM's latest
  // order, and so does a regroupOne once its stray group is gone (D60). The task point and where
  // the hero stands (D48, HeroPosition.ts) both follow it.
  effective(hero: IHero, running = runningCommand(hero, hero.command)): HeroCommand | null {
    if (running?.type !== 'regroupOne') return running;
    const llm = hero.lastLlmCommand;
    if (!llm || llm.type === 'regroupOne' || groupNear(this.straysOf(hero.faction), running.at))
      return running;
    return llm;
  }

  // A move walks its via points in order, then to its target (D60); a via point the hero cannot
  // reach (another walkable region) is passed over. The hero keeps the points it reached and when:
  // a route goes on from the points reached since its order was given (`since`), so the commander
  // restating the order, or Jev going back to it after a way around enemies that passed some of
  // its points, goes on from there, and a new order starts over
  private moveTarget(
    hero: IHero,
    command: HeroCommand & { type: 'move' },
    since: number
  ): Position {
    const via = command.via;
    if (!via || via.length === 0) return command.target;
    let i = viaReached(hero, via, since);
    const grid = this.sm.getBattlefield().grid;
    const here = tileOf(hero.position);
    const now = this.sm.getBattlefield().elapsedTime;
    for (; i < via.length; i++) {
      const p = via[i];
      // A hero standing behind its soldiers (D48) stays HERO_BEHIND_TILES back from their middle:
      // the point is reached when they are there
      const stand = hero.standPoint;
      const near =
        Math.hypot(p.x - hero.position.x, p.y - hero.position.y) <= VIA_ARRIVE_TILES ||
        (stand !== null &&
          Math.hypot(p.x - stand.x, p.y - stand.y) <= VIA_ARRIVE_TILES + HERO_BEHIND_TILES);
      if (!near && Pathfinder.sameRegion(grid, here.x, here.y, Math.floor(p.x), Math.floor(p.y)))
        return p;
      const reached = keptReached(hero);
      reached.push({ x: p.x, y: p.y, t: now });
      if (reached.length > VIA_REACHED_KEPT) reached.shift();
      hero.viaReached = reached;
    }
    return command.target;
  }

  // Orders that send the hero somewhere: move, retreat, regroup, attack base, or resuming one of
  // the LLM's.
  private isMovement(hero: IHero, command: HeroCommand): boolean {
    const c = runningCommand(hero, command);
    return (
      c?.type === 'move' ||
      c?.type === 'retreat' ||
      c?.type === 'regroup' ||
      c?.type === 'regroupOne' ||
      c?.type === 'attackBase'
    );
  }

  // null means "no destination": the hero stays where it is. Units can stand on a tile A* treats
  // as blocked (next to a mountain, after cutting a path's corner); a target on one would leave
  // the hero without a path, so targets that follow units are snapped to the nearest reachable
  // tile, like move orders.
  private target(hero: IHero, command: HeroCommand | null, since: number): Position | null {
    if (!command) return null;
    switch (command.type) {
      case 'move':
        return this.moveTarget(hero, command, since);
      case 'hold':
        return command.at;
      case 'retreat':
        return command.to ?? hero.home;
      case 'attack':
      case 'lead': {
        // The enemy in the hero's sight it goes for (D55); none: the hero stays where it is.
        // lead: the same target for the group, the hero itself stays behind it (D48)
        const enemy = attackTarget(this.sm, hero);
        return enemy ? nearestReachableTile(this.sm, enemy.position) : null;
      }
      case 'attackHero': {
        const target = this.sm
          .getHeroes()
          .find((h) => h.faction !== hero.faction && h.heroIndex === command.heroIndex && h.hp > 0);
        const enemy = target ?? attackTarget(this.sm, hero); // target dead: as attack
        return enemy ? nearestReachableTile(this.sm, enemy.position) : null;
      }
      case 'regroup': {
        // No strays: the hero stays where it is
        const cluster = regroupTarget(this.straysOf(hero.faction), hero);
        return cluster ? nearestReachableTile(this.sm, regroupPoint(cluster, hero)) : null;
      }
      case 'regroupOne': {
        // The group near the point while it has soldiers left (then the LLM's latest order runs,
        // effective(); nothing, without one)
        const group = groupNear(this.straysOf(hero.faction), command.at);
        return group ? nearestReachableTile(this.sm, regroupPoint(group, hero)) : null;
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
// A hold restated where the hero holds (within HOLD_SAME_TILES, it is pushed around by its
// neighbours) keeps the original hold position; a hold elsewhere is a new order, so a hold "here"
// is not taken for an earlier hold somewhere else (the hero walked back to it).
export function sameCommand(a: HeroCommand, b: HeroCommand): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'hold' && b.type === 'hold') {
    return Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) <= HOLD_SAME_TILES;
  }
  if (a.type === 'move' && b.type === 'move') return routeKey(a) === routeKey(b);
  if (a.type === 'attackHero' && b.type === 'attackHero') return a.heroIndex === b.heroIndex;
  // The same group: its centre moves as soldiers join the hero
  if (a.type === 'regroupOne' && b.type === 'regroupOne')
    return Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) <= REGROUP_ONE_TILES;
  return true;
}

function finitePoint(command: HeroCommand): boolean {
  const points =
    command.type === 'move'
      ? [command.target, ...(command.via ?? [])]
      : command.type === 'hold' || command.type === 'regroupOne'
        ? [command.at]
        : command.type === 'retreat' && command.to
          ? [command.to]
          : [];
  return points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

// The stray group a regroupOne order collects: the one whose centre is nearest its point, within
// REGROUP_ONE_TILES of it (D60)
export function groupNear(clusters: StrayCluster[], at: Position): StrayCluster | null {
  let best: StrayCluster | null = null;
  let bestD = REGROUP_ONE_TILES;
  for (const c of clusters) {
    const d = Math.hypot(c.center.x - at.x, c.center.y - at.y);
    if (d <= bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// How many of a route's via points the hero reached in order since `since` (D60)
export function viaReached(hero: IHero, via: Position[], since: number): number {
  let i = 0;
  for (const r of hero.viaReached ?? []) {
    if (i >= via.length) break;
    if (r.t >= since && r.x === via[i].x && r.y === via[i].y) i++;
  }
  return i;
}

// When the order a hero runs was given: Jev's "follow the LLM" runs the LLM's order (D15), and an
// LLM order restated after another one ran keeps the time it was first given
export function orderTime(hero: IHero): number {
  return hero.command?.type === 'continueLlm' || hero.commandSource === 'llm'
    ? hero.lastLlmTime
    : hero.commandTime;
}

// The via points reached that can still count: since the hero's order was given (its own route,
// or Jev's way around), or since the LLM's order was given if they are on its route (followed
// again later, viaReached); any other can never count again
function keptReached(hero: IHero): Array<{ x: number; y: number; t: number }> {
  const llmVia = hero.lastLlmCommand?.type === 'move' ? (hero.lastLlmCommand.via ?? []) : [];
  return (hero.viaReached ?? []).filter(
    (r) =>
      r.t >= hero.commandTime ||
      (r.t >= hero.lastLlmTime && llmVia.some((p) => p.x === r.x && p.y === r.y))
  );
}

// A move's route as text: its via points and its target, e.g. "40,30;55,32>75,45"
export function routeKey(c: HeroCommand & { type: 'move' }): string {
  return `${(c.via ?? []).map((p) => `${p.x},${p.y}`).join(';')}>${c.target.x},${c.target.y}`;
}

// The order a command runs: Jev's "follow the LLM" runs the LLM's latest order
export function runningCommand(hero: IHero, command = hero.command): HeroCommand | null {
  return command?.type === 'continueLlm' ? hero.lastLlmCommand : command;
}
