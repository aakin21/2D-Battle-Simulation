import { StateManager } from '../state/StateManager';
import { Pathfinder } from '../engine/Pathfinder';
import { ATTACK_CHASE_TILES, CONTROL_CAPTURE_SECONDS } from '../engine/Rules';
import { hasAttackTarget, nearestReachableTile } from '../engine/UnitHelpers';
import { enemyBase } from '../engine/Objectives';
import { regroupTarget, type StrayCluster } from '../engine/Strays';
import { GRID_SIZE, HeroCommand, IHero, Position } from '../types/types';
import { JEV_STEP_TILES, RETREAT_ABOUT_TILES } from './GameRules';
import { describeCommand } from './Describe';
import { detourFor, threatCosts } from './Detour';
import { COMPASS, distance, hpPercent, towards, VIEW_RADIUS } from './Observations';
import { alliesOf, enemyHeroesNear, nearbyStrays, pointHolder } from './JevSituation';

// What Jev is asked about one hero (D20, D26): a choice over the options we define, each with
// what it is for and what it is not for and the command it runs, and three small assessment
// questions that are logged and reported to the LLM (R5).

const STEP_TILES = JEV_STEP_TILES; // length of a "step" move
const TOGETHER_TILES = 8; // an allied hero this close is already with the hero (no approach option)

export interface JevOption {
  key: string;
  what: string;
  notFor: string;
  command: HeroCommand;
}

// The questions about one hero, in the order they are sent; `key` names the hero ("hero2")
export function heroQuestions(
  key: string,
  hero: IHero,
  options: JevOption[]
): Record<string, unknown> {
  const order = hero.lastLlmCommand;
  return {
    [key]: {
      type: 'choice',
      instructions: { hero: key, question: `What should \`${key}\` do right now?` },
      criteria: Object.fromEntries(
        options.map((o) => [o.key, { what: o.what, not_for: o.notFor }])
      ),
    },
    [`${key}_surrounded`]: {
      type: 'noul',
      instructions: `Is \`${key}\` being surrounded: enemies on several sides and its way back closing?`,
    },
    [`${key}_threat`]: {
      type: 'score',
      instructions: `How dangerous is the situation around \`${key}\` right now?`,
      criteria: [
        'Safe: no enemies near',
        'Low: enemies near, but we are clearly stronger here',
        'High: enemies about as strong as us or stronger here',
        'Critical: the hero is about to die or lose its soldiers',
      ],
    },
    ...(order
      ? {
          [`${key}_order_fits`]: {
            type: 'noul',
            instructions: `Does the commander's order for \`${key}\` (${describeCommand(order, 'jev')}${order.reason ? `, given because: ${order.reason}` : ''}) still make sense in its current situation?`,
          },
        }
      : {}),
  };
}

// The options Jev can choose from for one hero. Moves are short steps: Jev decides locally, the
// LLM moves map-wide. `strays` are the side's stray clusters (strayClusters); `threats` gives the
// side's cost of tiles near enemies (threatCosts), computed only when a hero needs it.
export function jevOptions(
  sm: StateManager,
  hero: IHero,
  strays: StrayCluster[],
  threats: () => Uint8Array = () => threatCosts(sm, hero.faction)
): JevOption[] {
  const here = { x: Math.floor(hero.position.x), y: Math.floor(hero.position.y) };
  const opts: JevOption[] = [];
  const order = hero.lastLlmCommand;

  if (order) {
    opts.push({
      key: 'continue_llm',
      what: `Keep following the commander's order: ${describeCommand(order, 'jev')}${order.reason ? ` (its reason: ${order.reason})` : ''}.`,
      notFor: 'When the hero is in danger or the order no longer fits the local situation.',
      command: { type: 'continueLlm' },
    });
    // D60: the commander's move by a way around the enemies near it, worked out by code
    const detour = detourFor(sm, hero, threats());
    if (detour) {
      opts.push({
        key: 'continue_around',
        what: `Go on with the commander's order by a way that keeps away from enemy units: about ${detour.length} tiles (the direct way, about ${detour.direct} tiles, passes near enemy units); the soldiers follow the hero the same way.`,
        notFor:
          'When the enemies on the direct way are weak and the fight is worth it, or the hero is already in a fight.',
        command: detour.command,
      });
    }
  }
  opts.push(
    {
      key: 'hold',
      what: 'Stay at the current position and fight what comes.',
      notFor: 'When clearly outnumbered and losing, or when enemies are slipping around the group.',
      command: { type: 'hold', at: here },
    },
    {
      key: 'retreat',
      what: `Fall back about ${RETREAT_ABOUT_TILES} tiles from the enemies near the hero (what it walks before the next decision; not to the start position) and stay there, to save the hero and its soldiers. Chosen again once the hero has arrived, it falls back further.`,
      notFor: 'When winning the local fight or when the enemy is weak.',
      command: { type: 'retreat' },
    }
  );
  // With no enemy to go for (none in sight, none chased) attack and lead keep the hero where
  // it is, so they are not offered (D55)
  if (hasAttackTarget(sm, hero))
    opts.push(
      {
        key: 'attack',
        what: `Advance on the nearest enemy unit in the hero's sight with the hero in front, fighting, and keep after it until it dies or is more than ${ATTACK_CHASE_TILES} tiles away.`,
        notFor: 'When the enemy is clearly stronger nearby or the soldiers are fleeing.',
        command: { type: 'attack' },
      },
      {
        key: 'lead',
        what: `Send the soldiers at the nearest enemy unit in the hero's sight; the hero follows behind them; they keep after it until it dies or is more than ${ATTACK_CHASE_TILES} tiles away.`,
        notFor: 'When the hero has too few soldiers near it to stay behind.',
        command: { type: 'lead' },
      }
    );

  for (const { enemy, d } of enemyHeroesNear(sm, hero)) {
    opts.push({
      key: `attack_hero_${enemy.heroIndex}`,
      what: `Chase enemy hero ${enemy.heroIndex} (${Math.round(d)} tiles ${towards(hero.position, enemy.position)}, ${hpPercent(enemy)}% HP); killing it takes away its soldiers' courage bonus.`,
      notFor: 'When that hero is protected by a stronger group, or our own hero is badly hurt.',
      command: { type: 'attackHero', heroIndex: enemy.heroIndex },
    });
  }

  // A short step toward each allied hero that is not already with it: Jev brings the hero to
  // an ally step by step, looking at its surroundings before each step. The step follows the
  // path there (a straight line could end in a mountain, and the hero stopped at its near side);
  // an ally the hero cannot reach (another walkable region) is not offered.
  const grid = sm.getBattlefield().grid;
  for (const ally of alliesOf(sm, hero)) {
    const d = distance(hero.position, ally.position);
    if (d <= TOGETHER_TILES) continue;
    const path = Pathfinder.findPath(grid, here, nearestReachableTile(sm, ally.position));
    if (path.length === 0) continue;
    const step = alongPath(here, path, STEP_TILES);
    opts.push({
      key: `approach_hero_${ally.heroIndex}`,
      what: `Move about ${Math.round(step.walked)} tiles toward our hero ${ally.heroIndex} (${Math.round(d)} tiles ${towards(hero.position, ally.position)}), to join or support it; chosen again, it closes in further.`,
      notFor: 'When enemies block the way, or the hero is needed in the fight it is in.',
      command: { type: 'move', target: step.point },
    });
  }

  for (const p of sm.getBattlefield().objective.points) {
    const d = Math.round(distance(hero.position, p.position));
    opts.push({
      key: `move_to_${p.name}`,
      what: `Go to control point ${p.name} (${d} tiles ${towards(hero.position, p.position)}, held by ${pointHolder(p, hero.faction)} now) and stay; the side with more units there takes it after ${CONTROL_CAPTURE_SECONDS} s and then scores.`,
      notFor:
        'When the hero is needed in the fight it is in, or the point is held strongly by the enemy.',
      command: { type: 'move', target: p.position },
    });
  }
  const target = enemyBase(sm, hero.faction);
  if (target && target.hp > 0) {
    const d = Math.round(distance(hero.position, target.position));
    opts.push({
      key: 'attack_base',
      what: `March on the enemy base (${d} tiles ${towards(hero.position, target.position)}, ${hpPercent(target)}% HP) and attack it.`,
      notFor: 'When enemy units nearby are stronger, or our own base is under attack.',
      command: { type: 'attackBase' },
    });
  }

  // Offered when strays are near; described by the group the order actually leads to, which
  // can be a bigger group farther away (regroupTarget weighs distance by group size)
  const goal = nearbyStrays(hero, strays).length > 0 ? regroupTarget(strays, hero) : null;
  if (goal) {
    const d = Math.round(distance(hero.position, goal.center));
    opts.push({
      key: 'regroup',
      what: `Collect stray soldiers of our side, one group after another until none is left: it starts with a group of ${goal.soldiers} soldiers, ${d} tiles ${towards(hero.position, goal.center)} (a bigger group is preferred to a nearer small one); they follow the hero again and regain its courage bonus.`,
      notFor: 'When the hero is in a fight it is winning, or the strays are far away.',
      command: { type: 'regroup' },
    });
  }
  // D60: one group only, then back to the commander's order: the nearest group within the view,
  // preferring bigger ones as regroup does
  const one = order
    ? regroupTarget(
        strays.filter((c) => distance(hero.position, c.center) <= VIEW_RADIUS),
        hero
      )
    : null;
  if (one && order) {
    const d = Math.round(distance(hero.position, one.center));
    opts.push({
      key: 'regroup_short',
      what: `Collect only the group of ${one.soldiers} stray soldiers ${d} tiles ${towards(hero.position, one.center)}, then go back to the commander's order (${describeCommand(order, 'jev')}).`,
      notFor: 'When the group is small and far away, or the hero is in a fight.',
      command: {
        type: 'regroupOne',
        at: { x: Math.round(one.center.x), y: Math.round(one.center.y) },
      },
    });
  }

  COMPASS.forEach((dir, i) => {
    const angle = (i * Math.PI) / 4;
    const target = {
      x: Math.round(
        Math.max(1, Math.min(GRID_SIZE - 2, hero.position.x + Math.cos(angle) * STEP_TILES))
      ),
      y: Math.round(
        Math.max(1, Math.min(GRID_SIZE - 2, hero.position.y + Math.sin(angle) * STEP_TILES))
      ),
    };
    opts.push({
      key: `step_${dir.replace('-', '_')}`,
      what: `Move about ${STEP_TILES} tiles ${dir}: reposition to better ground, join allies, or avoid being surrounded.`,
      notFor: "Long moves across the map; that is the commander's job.",
      command: { type: 'move', target },
    });
  });
  // D60: the commander's fallback marks the option it names (regroup: collecting one group and
  // going back to the order, when offered); Jev judges whether its condition has come about
  const fallback = order?.fallback;
  if (fallback) {
    const keys = fallback.do === 'regroup' ? ['regroup_short', 'regroup'] : [fallback.do];
    const marked = keys.map((k) => opts.find((o) => o.key === k)).find((o) => o);
    if (marked)
      marked.what += ` The commander's fallback for this hero: choose this when ${fallback.when}.`;
  }
  return opts;
}

// The point about `tiles` along a path (tile coordinates, without the start tile), and how far
// that is; the path's end when it is shorter
function alongPath(
  start: Position,
  path: Position[],
  tiles: number
): { point: Position; walked: number } {
  let prev = start;
  let walked = 0;
  for (const p of path) {
    const seg = Math.hypot(p.x - prev.x, p.y - prev.y);
    if (walked + seg >= tiles) {
      // A smoothed path's segment can be long (open ground: one straight line to the end)
      const f = (tiles - walked) / seg;
      const point = {
        x: Math.round(prev.x + (p.x - prev.x) * f),
        y: Math.round(prev.y + (p.y - prev.y) * f),
      };
      return { point, walked: tiles };
    }
    walked += seg;
    prev = p;
  }
  return { point: path[path.length - 1], walked };
}
