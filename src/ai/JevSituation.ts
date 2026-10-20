import { StateManager } from '../state/StateManager';
import { positionToSubsector } from '../engine/Sectors';
import { wholePoints } from '../engine/Objectives';
import { opponent } from '../engine/Sides';
import type { StrayCluster } from '../engine/Strays';
import { ControlPoint, Faction, GRID_SIZE, IHero, IUnit, TerrainType } from '../types/types';
import { describeCommand, heroStatus } from './Describe';
import {
  distance,
  exactPlace,
  formatRatio,
  GroupStats,
  hpPercent,
  localForce,
  LOCAL_RADIUS,
  secondsLeft,
  sideScores,
  towards,
} from './Observations';

// What Jev is told about one hero in its request's state (D16, D26): the hero's status, its
// orders and its surroundings, and the objective from its side's point of view (D30).

const HERO_SCAN = LOCAL_RADIUS * 2; // enemy heroes within this distance can be targeted
const STRAY_REACH = 25; // stray groups within this distance are shown to Jev
const MAP_CELL = 2; // local map: one character per 2×2 tiles

// What one hero's description is computed from besides the hero itself. `groups` and `strays`
// are taken once per request; the previous values are the Jev layer's memory of its last request.
export interface HeroContext {
  time: number;
  force: { allies: number; enemies: number; ratio: number };
  groups: Map<string, GroupStats>;
  strays: StrayCluster[];
  previousForce: number | undefined; // force ratio at the previous request
  previousChoice: string | undefined; // the last option applied for this hero
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
  const enemyHeroes = enemyHeroesNear(sm, hero).map(
    ({ enemy, d }) =>
      `enemy hero ${enemy.heroIndex}, ${Math.round(d)} tiles ${towards(hero.position, enemy.position)}, ${hpPercent(enemy)}% HP`
  );
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
    enemy_heroes_nearby: enemyHeroes.length ? enemyHeroes : 'none',
    allied_heroes: alliedHeroes(sm, hero, groups),
    stray_soldiers_nearby: nearbyStrays(hero, ctx.strays).map(
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
  groups: Map<string, GroupStats>
): string[] | string {
  const lines: string[] = [];
  for (const ally of alliesOf(sm, hero)) {
    const d = distance(hero.position, ally.position);
    const enemies = localForce(sm, ally).enemies;
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
    .filter((s) => s.distance <= STRAY_REACH)
    .sort((a, b) => a.distance - b.distance);
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
