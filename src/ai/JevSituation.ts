import { StateManager } from '../state/StateManager';
import { Pathfinder } from '../engine/Pathfinder';
import { positionToSubsector } from '../engine/Sectors';
import { wholePoints } from '../engine/Objectives';
import { opponent } from '../engine/Sides';
import { strayClusters, type StrayCluster } from '../engine/Strays';
import { nearestReachableTile } from '../engine/UnitHelpers';
import {
  ControlPoint,
  Faction,
  GRID_SIZE,
  IHero,
  IUnit,
  Position,
  TerrainType,
} from '../types/types';
import { describeCommand, heroStatus } from './Describe';
import {
  compass,
  distance,
  exactPlace,
  formatRatio,
  GroupStats,
  hpPercent,
  LOCAL_RADIUS,
  VIEW_RADIUS,
  secondsLeft,
  sideScores,
  towards,
} from './Observations';

// What Jev is told about one hero in its request's state (D16, D26): the hero's status, its
// orders and its surroundings, and the objective from its side's point of view (D30).

const HERO_SCAN = LOCAL_RADIUS * 2; // enemy heroes within this distance can be targeted
const MAP_CELL = 2; // local map: one character per 2×2 tiles

// Jev's wider view (VIEW_RADIUS): the groups that can reach a hero within about two decisions.
// Given as computed lines, not as a bigger map: language models read lists of relations better
// than grids (R11)
const VIEW_GROUPS = 5; // nearest enemy groups shown
const VIEW_STRAYS = 4; // nearest groups of our own strays shown
const MIN_STRAY_GROUP = 3; // smaller enemy stray groups are left out of the view
const MOVED_TILES = 2; // a hero that moved less than this since the last decision is standing
const WAY_NEAR = 12; // a group this close to the way ahead is on it (soldiers fight what they see within 10)
const WAY_STEP = 2; // the way ahead is checked every this many tiles

const TOGETHER_TILES = 8; // heroes of a side this close lead one army (their soldiers mix)

// A group of enemy units Jev sees: enemy heroes standing together with their followers, or a
// cluster of enemy strays (no heroes)
export interface EnemyGroup {
  heroes: IHero[];
  soldiers: number;
  center: Position;
  hp: number; // total HP, the heroes' included
}

// The living heroes of one side in groups that stand together (within TOGETHER_TILES of one
// another, chained), each in the side's hero order. Soldiers follow the nearest hero, so heroes
// standing together share one army: counted apart, one showed 70 soldiers and the others none
export function heroGroups(sm: StateManager, faction: Faction): IHero[][] {
  const heroes = sm.getHeroes().filter((h) => h.faction === faction && h.hp > 0);
  const groups: IHero[][] = [];
  const placed = new Set<IHero>();
  for (const first of heroes) {
    if (placed.has(first)) continue;
    const group = [first];
    placed.add(first);
    for (let i = 0; i < group.length; i++)
      for (const h of heroes)
        if (!placed.has(h) && distance(group[i].position, h.position) <= TOGETHER_TILES) {
          group.push(h);
          placed.add(h);
        }
    groups.push(group.sort((a, b) => a.heroIndex - b.heroIndex));
  }
  return groups;
}

// The heroes, soldiers and total HP of an army led by heroes standing together
function army(heroes: IHero[], stats: Map<string, GroupStats>): { soldiers: number; hp: number } {
  let soldiers = 0;
  let hp = 0;
  for (const h of heroes) {
    const g = stats.get(h.id);
    soldiers += g?.followers ?? 0;
    hp += h.hp + (g?.hp ?? 0);
  }
  return { soldiers, hp };
}

// The middle of some positions
function middle(points: Position[]): Position {
  return {
    x: points.reduce((s, p) => s + p.x, 0) / points.length,
    y: points.reduce((s, p) => s + p.y, 0) / points.length,
  };
}

// Every enemy group on the map, computed once per request for all heroes of the side
export function enemyGroupsOf(
  sm: StateManager,
  faction: Faction,
  enemyStats: Map<string, GroupStats>
): EnemyGroup[] {
  const groups: EnemyGroup[] = heroGroups(sm, opponent(faction)).map((heroes) => ({
    heroes,
    center: middle(heroes.map((h) => h.position)),
    ...army(heroes, enemyStats),
  }));
  for (const c of strayClusters(sm, opponent(faction))) {
    if (c.soldiers < MIN_STRAY_GROUP) continue;
    groups.push({
      heroes: [],
      soldiers: c.soldiers,
      center: c.center,
      hp: c.members.reduce((sum, u) => sum + u.hp, 0),
    });
  }
  return groups;
}

// How a group is named: "enemy hero 2 with 45 soldiers", "enemy heroes 1 and 3 with 80
// soldiers", "12 stray enemy soldiers"
function groupName(g: EnemyGroup): string {
  if (g.heroes.length === 0) return `${g.soldiers} stray enemy soldiers`;
  const ids = g.heroes.map((h) => h.heroIndex);
  const heroes =
    ids.length === 1
      ? `enemy hero ${ids[0]}`
      : `enemy heroes ${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
  return `${heroes} with ${g.soldiers} soldiers`;
}

// What one hero's description is computed from besides the hero itself. `groups`, `strays`,
// `ownGroups` and `forceOf` are taken once per request; the previous values are the Jev layer's
// memory of its last request.
export interface HeroContext {
  time: number;
  force: { allies: number; enemies: number; ratio: number };
  groups: Map<string, GroupStats>;
  strays: StrayCluster[];
  enemyGroups: EnemyGroup[];
  ownGroups: IHero[][]; // heroGroups of the hero's side
  forceOf: (hero: IHero) => { allies: number; enemies: number; ratio: number }; // localForce
  previousForce: number | undefined; // force ratio at the previous request
  previousChoice: string | undefined; // the last option applied for this hero
  // Where every hero was at the previous request and when, to tell how enemy heroes move
  previousPositions: { time: number; at: Map<string, Position> } | undefined;
}

export function heroSituation(
  sm: StateManager,
  hero: IHero,
  ctx: HeroContext
): Record<string, unknown> {
  const { time, force, groups, previousForce } = ctx;
  const group = groups.get(hero.id);
  let nearest: IUnit | null = null;
  let nearestD = Infinity;
  sm.forEachInRadius(hero.position.x, hero.position.y, LOCAL_RADIUS, (u) => {
    if (u.hp <= 0 || u.faction === hero.faction) return;
    const d = distance(hero.position, u.position);
    if (d < nearestD) {
      nearestD = d;
      nearest = u;
    }
  });
  const order = hero.lastLlmCommand;

  return {
    hp_percent: hpPercent(hero),
    status: heroStatus(hero, 'jev'),
    place: positionToSubsector(hero.position),
    current_order: hero.command
      ? `${describeCommand(hero.command, 'jev')} (from ${hero.commandSource})`
      : 'none',
    commander_order: order ? describeCommand(order, 'jev') : 'none',
    commander_reason: order ? (order.reason ?? 'not given') : 'n/a',
    commander_fallback: order
      ? order.fallback
        ? `${order.fallback.do} when ${order.fallback.when}`
        : 'none given'
      : 'n/a',
    commander_order_age_seconds: order ? Math.round(time - hero.lastLlmTime) : 'n/a',
    my_previous_decision: ctx.previousChoice ?? 'none',
    soldiers_following: group?.followers ?? 0,
    soldiers_avg_hp_percent: group?.avgHpPercent ?? 0,
    soldiers_avg_courage: group?.avgCourage ?? 0,
    soldiers_fleeing: group?.fleeing ?? 0,
    allies_nearby: force.allies,
    enemies_nearby: force.enemies,
    force_ratio: formatRatio(force.ratio),
    force_ratio_4s_ago: previousForce === undefined ? 'n/a' : formatRatio(previousForce),
    nearest_enemy: nearest
      ? `${Math.round(nearestD)} tiles ${towards(hero.position, (nearest as IUnit).position)}`
      : 'none in sight',
    enemy_groups_in_view: enemyGroupsInView(sm, hero, ctx),
    way_ahead: wayAhead(sm, hero, ctx.enemyGroups),
    allied_heroes: alliedHeroes(sm, hero, groups, ctx.forceOf),
    stray_soldiers_nearby: nearbyStrays(hero, ctx.strays)
      .slice(0, VIEW_STRAYS)
      .map(
        (s) =>
          `${s.soldiers} stray soldiers, ${s.distance} tiles ${s.direction}, ${s.avgCourage} courage`
      ),
    local_map: localMap(sm, hero),
  };
}

// Living enemy heroes within HERO_SCAN of the hero, with their distance
export function enemyHeroesNear(sm: StateManager, hero: IHero): Array<{ enemy: IHero; d: number }> {
  const near: Array<{ enemy: IHero; d: number }> = [];
  for (const enemy of sm.getHeroes()) {
    if (enemy.faction === hero.faction || enemy.hp <= 0) continue;
    const d = distance(hero.position, enemy.position);
    if (d <= HERO_SCAN) near.push({ enemy, d });
  }
  return near;
}

// The other living heroes of the hero's side
export function alliesOf(sm: StateManager, hero: IHero): IHero[] {
  return sm.getHeroes().filter((h) => h.faction === hero.faction && h.hp > 0 && h.id !== hero.id);
}

// The other heroes of this side, wherever they are, so that Jev can bring the hero to one of
// them step by step (e.g. when the commander's reason says to join or support it)
function alliedHeroes(
  sm: StateManager,
  hero: IHero,
  groups: Map<string, GroupStats>,
  forceOf: HeroContext['forceOf']
): string[] | string {
  const lines: string[] = [];
  for (const ally of alliesOf(sm, hero)) {
    const d = distance(hero.position, ally.position);
    const enemies = forceOf(ally).enemies;
    lines.push(
      `hero ${ally.heroIndex}, ${Math.round(d)} tiles ${towards(hero.position, ally.position)} in ${positionToSubsector(ally.position)}, ${hpPercent(ally)}% HP, ${groups.get(ally.id)?.followers ?? 0} soldiers, ${enemies > 0 ? `${enemies} enemies within ${LOCAL_RADIUS} tiles of it` : 'no enemies near it'}`
    );
  }
  return lines.length ? lines : 'none (this is our last hero)';
}

// Clusters of this side's stray soldiers within reach of the hero, nearest first (D28).
export function nearbyStrays(
  hero: IHero,
  strays: StrayCluster[]
): Array<{ soldiers: number; distance: number; direction: string; avgCourage: number }> {
  return strays
    .map((c) => ({
      soldiers: c.soldiers,
      distance: Math.round(distance(hero.position, c.center)),
      direction: towards(hero.position, c.center),
      avgCourage: c.avgCourage,
    }))
    .filter((s) => s.distance <= VIEW_RADIUS)
    .sort((a, b) => a.distance - b.distance);
}

// The enemy groups within VIEW_RADIUS of the hero, nearest first: who they are, where, how
// strong against this hero's own group, and how an enemy hero has moved since the last decision
function enemyGroupsInView(sm: StateManager, hero: IHero, ctx: HeroContext): string[] | string {
  const together = ctx.ownGroups.find((g) => g.includes(hero)) ?? [hero];
  const ours = army(together, ctx.groups).hp;
  const seen = ctx.enemyGroups
    .map((g) => ({ g, d: distance(hero.position, g.center) }))
    .filter((x) => x.d <= VIEW_RADIUS)
    .sort((a, b) => a.d - b.d)
    .slice(0, VIEW_GROUPS);
  if (seen.length === 0) return `none within ${VIEW_RADIUS} tiles`;
  return seen.map(({ g, d }) => {
    const heroes = g.heroes.map((h) => `${hpPercent(h)}% HP, ${heroStatus(h, 'jev')}`);
    const state = heroes.length
      ? ` (hero${heroes.length > 1 ? 'es' : ''}: ${heroes.join('; ')})`
      : '';
    const moving = g.heroes.length ? `, ${groupMovement(hero, g, ctx)}` : '';
    return `${groupName(g)}${state}, ${Math.round(d)} tiles ${towards(hero.position, g.center)}${moving}, our force ratio against it ${formatRatio(ours / g.hp)}`;
  });
}

// How an enemy group led by heroes moved since the previous decision, as anyone watching would
// see it: its direction, and whether it came closer to this hero. Orders are never told (D16).
function groupMovement(hero: IHero, g: EnemyGroup, ctx: HeroContext): string {
  const before = ctx.previousPositions;
  const heroThen = before?.at.get(hero.id);
  const then = g.heroes.map((h) => before?.at.get(h.id));
  if (!before || !heroThen || then.some((p) => !p)) return 'movement not known yet';
  const groupThen = middle(then as Position[]);
  const seconds = Math.round(ctx.time - before.time);
  const moved = distance(groupThen, g.center);
  const closer = distance(heroThen, groupThen) - distance(hero.position, g.center);
  const way = moved < MOVED_TILES ? 'not moving' : `moving ${compass(groupThen, g.center)}`;
  const gap =
    Math.abs(closer) < MOVED_TILES
      ? 'about as far as'
      : `${Math.round(Math.abs(closer))} tiles ${closer > 0 ? 'closer than' : 'farther than'}`;
  return `${way}, ${gap} ${seconds} s ago`;
}

// Where the hero's way to its order's point leads within VIEW_RADIUS, and which enemy groups lie
// close to it there. The way is the path the pathfinder takes (it does not avoid enemies), which
// the hero and its soldiers walk.
function wayAhead(sm: StateManager, hero: IHero, enemyGroups: EnemyGroup[]): string {
  const target = hero.taskPoint;
  if (!target) return 'the hero has no point to go to';
  const here = { x: Math.floor(hero.position.x), y: Math.floor(hero.position.y) };
  const path = Pathfinder.findPath(
    sm.getBattlefield().grid,
    here,
    nearestReachableTile(sm, target)
  );
  const toGo = Math.round(distance(hero.position, target));
  if (path.length === 0)
    return `at its point, or no way there (${toGo} tiles ${towards(hero.position, target)})`;

  // Points every WAY_STEP tiles along the path, up to VIEW_RADIUS
  const points: Position[] = [];
  let prev: Position = here;
  let walked = 0;
  for (const next of path) {
    const len = distance(prev, next);
    for (
      let t = WAY_STEP - (walked % WAY_STEP);
      t <= len && walked + t <= VIEW_RADIUS;
      t += WAY_STEP
    ) {
      points.push({
        x: prev.x + ((next.x - prev.x) * t) / len,
        y: prev.y + ((next.y - prev.y) * t) / len,
      });
    }
    walked += len;
    prev = next;
    if (walked >= VIEW_RADIUS) break;
  }
  points.push(prev);

  const onIt: string[] = [];
  for (const g of enemyGroups) {
    let best = Infinity;
    let bestAlong = 0;
    points.forEach((p, i) => {
      const d = distance(p, g.center);
      if (d < best) {
        best = d;
        bestAlong = Math.min(walked, (i + 1) * WAY_STEP);
      }
    });
    if (best > WAY_NEAR) continue;
    onIt.push(
      `${groupName(g)} ${Math.round(best)} tiles from it, ${Math.round(bestAlong)} tiles ahead`
    );
  }
  const length = Math.round(walked);
  const where = `to its point ${toGo} tiles ${towards(hero.position, target)} (path ${length > VIEW_RADIUS ? `over ${VIEW_RADIUS}` : length} tiles), first heading ${compass(here, points[0] ?? prev)}`;
  return onIt.length
    ? `${where}; enemy groups near it within ${VIEW_RADIUS} tiles: ${onIt.join('; ')}`
    : `${where}; no enemy group near it within ${VIEW_RADIUS} tiles`;
}

// A small text map centred on the hero, north at the top. Each character is a 2×2 tile
// area: H hero, e enemies, a allies, M mountain, f forest, s swamp, . open ground.
export function localMap(sm: StateManager, hero: IHero): Record<string, unknown> {
  const grid = sm.getBattlefield().grid;
  const half = Math.floor(LOCAL_RADIUS / MAP_CELL);
  const hx = Math.floor(hero.position.x / MAP_CELL);
  const hy = Math.floor(hero.position.y / MAP_CELL);

  const marks = new Map<number, string>();
  sm.forEachInRadius(hero.position.x, hero.position.y, LOCAL_RADIUS * 1.5, (u) => {
    if (u.hp <= 0) return;
    const k = Math.floor(u.position.y / MAP_CELL) * 1000 + Math.floor(u.position.x / MAP_CELL);
    if (u.faction !== hero.faction) marks.set(k, 'e');
    else if (!marks.has(k)) marks.set(k, 'a');
  });

  const rows: string[] = [];
  for (let cy = hy - half; cy <= hy + half; cy++) {
    let line = '';
    for (let cx = hx - half; cx <= hx + half; cx++) {
      if (cx === hx && cy === hy) {
        line += 'H';
        continue;
      }
      const x = cx * MAP_CELL;
      const y = cy * MAP_CELL;
      if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) {
        line += '#';
        continue;
      }
      line += marks.get(cy * 1000 + cx) ?? TERRAIN_MARK[cellTerrain(grid, x, y)];
    }
    rows.push(line);
  }
  return {
    legend:
      'H this hero, e enemy, a ally, M mountain (impassable), f forest, s swamp, . open, # map edge; north is up, each character is 2x2 tiles',
    rows,
  };
}

const TERRAIN_MARK: Record<TerrainType, string> = {
  [TerrainType.OPEN]: '.',
  [TerrainType.FOREST]: 'f',
  [TerrainType.SWAMP]: 's',
  [TerrainType.MOUNTAIN]: 'M',
};

// Terrain of a 2×2 cell of the local map. Any mountain tile makes it a mountain, since units
// cannot pass there (the pathfinder also keeps off a mountain's neighbours); otherwise the
// terrain of most of its tiles (top-left on a tie). Reading only the top-left tile showed one
// in six cells with a mountain as passable.
function cellTerrain(grid: TerrainType[][], x: number, y: number): TerrainType {
  const counts = [0, 0, 0, 0];
  for (let dy = 0; dy < MAP_CELL; dy++) {
    for (let dx = 0; dx < MAP_CELL; dx++) {
      const t = grid[y + dy]?.[x + dx];
      if (t !== undefined) counts[t]++;
    }
  }
  if (counts[TerrainType.MOUNTAIN] > 0) return TerrainType.MOUNTAIN;
  let best = grid[y][x];
  for (const t of [TerrainType.OPEN, TerrainType.FOREST, TerrainType.SWAMP])
    if (counts[t] > counts[best]) best = t;
  return best;
}

// Who holds a control point, from this side's point of view: "us", "nobody, being taken by the
// enemy", …
export function pointHolder(p: ControlPoint, faction: Faction): string {
  const side = (f: Faction) => (f === faction ? 'us' : 'the enemy');
  return (
    (p.holder === null ? 'nobody' : side(p.holder)) +
    (p.leader !== null && p.leader !== p.holder ? `, being taken by ${side(p.leader)}` : '')
  );
}

// D30: objective status in the state, from this side's point of view.
export function objectiveState(sm: StateManager, faction: Faction): unknown {
  const o = sm.getBattlefield().objective;
  const left = secondsLeft(sm);
  if (o.mode === 'control') {
    const scores = sideScores(sm, faction);
    return {
      mode: 'control points',
      our_points: wholePoints(scores.ours),
      enemy_points: wholePoints(scores.theirs),
      seconds_left: left,
      points: o.points.map(
        (p) => `${p.name} at ${exactPlace(p.position)}, held by ${pointHolder(p, faction)}`
      ),
    };
  }
  if (o.mode === 'base') {
    const base = (f: Faction) => o.bases.find((x) => x.faction === f);
    const pct = (f: Faction) => {
      const b = base(f);
      return b ? hpPercent(b) : 0;
    };
    const at = (f: Faction) => {
      const b = base(f);
      return b ? exactPlace(b.position) : 'none';
    };
    const enemy = opponent(faction);
    return {
      mode: 'destroy the base',
      seconds_left: left,
      our_base_at: at(faction),
      our_base_hp_percent: pct(faction),
      enemy_base_at: at(enemy),
      enemy_base_hp_percent: pct(enemy),
    };
  }
  return { mode: 'elimination', seconds_left: left };
}
