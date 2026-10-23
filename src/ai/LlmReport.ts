import { StateManager } from '../state/StateManager';
import {
  positionToSector,
  positionToSubsector,
  SECTORS_PER_SIDE,
  SECTOR_SIZE,
} from '../engine/Sectors';
import { pointCounts, wholePoints } from '../engine/Objectives';
import { opponent } from '../engine/Sides';
import { strayClusters } from '../engine/Strays';
import { BehaviorState, Faction, TerrainType, UnitType } from '../types/types';
import { describeCommand, heroStatus } from './Describe';
import {
  armyHp,
  exactPlace,
  formatRatio,
  groupStats,
  hpPercent,
  localForce,
  objectivePlaces,
  secondsLeft,
  sideScores,
  wayToObjectives,
} from './Observations';
import type { JevAssessment, LlmDecision } from './LlmController';

// The LLM's report: the whole battlefield as computed values (D16, R5, D26), from one side's
// point of view, with what changed since the last report the LLM saw.

const MAX_STRAY_CLUSTERS = 5;

// What the last report that reached the LLM counted, for the changes in the next one
export interface ReportMemory {
  forceRatio: number | null;
  soldiers: { yours: number; enemy: number } | null;
  followers: Map<number, number>; // soldiers following each of this side's heroes
}

interface ReportInput {
  time: number;
  previous: LlmDecision | undefined; // the LLM's last decision
  memory: ReportMemory;
  events: string[]; // hero deaths and survival reflexes since the last report
  jevAssessment: ((heroIndex: number) => JevAssessment) | null;
}

// The report, and what the next report compares with once this one has reached the LLM
export function buildReport(
  sm: StateManager,
  faction: Faction,
  input: ReportInput
): { report: Record<string, unknown>; counted: ReportMemory } {
  const { time, memory } = input;
  const mine = (f: Faction) => f === faction;
  const heroes = sm.getHeroes().filter((h) => h.hp > 0);
  const myGroups = groupStats(sm, faction);
  const enemyFaction = opponent(faction);
  const enemyGroups = groupStats(sm, enemyFaction);

  // Armies and sectors: [count, sum of HP share, sum of courage, fleeing]
  const perSector = new Map<string, { y: number[]; e: number[] }>();
  const army = { yours: [0, 0, 0, 0], enemy: [0, 0, 0, 0] };
  for (const u of sm.getBattlefield().units) {
    if (u.hp <= 0 || u.unitType === UnitType.HERO) continue;
    const a = mine(u.faction) ? army.yours : army.enemy;
    a[0]++;
    a[1] += u.hp / u.maxHp;
    a[2] += u.courage;
    if (u.state === BehaviorState.FLEE) a[3]++;
    const key = positionToSector(u.position);
    const cell = perSector.get(key) ?? { y: [0, 0, 0], e: [0, 0, 0] };
    const c = mine(u.faction) ? cell.y : cell.e;
    c[0]++;
    c[1] += u.hp / u.maxHp;
    c[2] += u.courage;
    perSector.set(key, cell);
  }
  const avg = (sum: number, n: number, scale = 1) => (n ? Math.round((sum * scale) / n) : 0);
  const hp = armyHp(sm);
  const myHp = mine(Faction.FRIENDLY) ? hp.friendly : hp.enemy;
  const enemyHp = mine(Faction.FRIENDLY) ? hp.enemy : hp.friendly;
  const forceRatio = enemyHp > 0 ? myHp / enemyHp : Infinity;
  const cellInfo = (c: number[]) =>
    c[0]
      ? { soldiers: c[0], avg_hp_percent: avg(c[1], c[0], 100), avg_courage: avg(c[2], c[0]) }
      : 0;

  const last = input.previous;
  const objectives = objectivePlaces(sm, faction, 'your');
  const report = {
    time_seconds: Math.round(time),
    your_previous_decision: last
      ? { stance: last.stance, plan: last.plan, seconds_ago: Math.round(time - last.time) }
      : 'none (first report)',
    your_groups: heroes
      .filter((h) => mine(h.faction))
      .map((h) => {
        const g = myGroups.get(h.id);
        const jev = input.jevAssessment?.(h.heroIndex);
        const prev = memory.followers.get(h.heroIndex);
        return {
          hero: h.heroIndex,
          place: positionToSubsector(h.position),
          hero_hp_percent: hpPercent(h),
          hero_status: heroStatus(h, 'llm'),
          current_order: h.command
            ? `${describeCommand(h.command, 'llm')} (from ${h.commandSource}${h.command.reason ? `: ${h.command.reason}` : ''})`
            : 'none',
          soldiers_following: g?.followers ?? 0,
          soldiers_change_since_last_report:
            prev === undefined ? 'n/a' : (g?.followers ?? 0) - prev,
          soldiers_avg_hp_percent: g?.avgHpPercent ?? 0,
          soldiers_avg_courage: g?.avgCourage ?? 0,
          soldiers_fleeing: g?.fleeing ?? 0,
          local_force_ratio: formatRatio(localForce(sm, h).ratio),
          ...(objectives.length ? { way_to_objectives: wayToObjectives(h, objectives) } : {}),
          ...(jev
            ? {
                jev_recent_decisions: jev.recentDecisions,
                jev_surrounded_probability: jev.surrounded,
                jev_threat_0_to_3: jev.threat,
                jev_your_order_still_fits_probability: jev.orderStillFits,
              }
            : {}),
        };
      }),
    enemy_groups: heroes
      .filter((h) => !mine(h.faction))
      .map((h) => {
        const g = enemyGroups.get(h.id);
        return {
          hero: h.heroIndex,
          place: positionToSubsector(h.position),
          hero_hp_percent: hpPercent(h),
          hero_status: heroStatus(h, 'llm'),
          soldiers_following: g?.followers ?? 0,
          soldiers_avg_hp_percent: g?.avgHpPercent ?? 0,
          soldiers_avg_courage: g?.avgCourage ?? 0,
          soldiers_fleeing: g?.fleeing ?? 0,
        };
      }),
    armies: {
      your_soldiers: army.yours[0],
      enemy_soldiers: army.enemy[0],
      your_soldiers_lost_since_last_report: memory.soldiers
        ? memory.soldiers.yours - army.yours[0]
        : 'n/a',
      enemy_soldiers_lost_since_last_report: memory.soldiers
        ? memory.soldiers.enemy - army.enemy[0]
        : 'n/a',
      your_avg_hp_percent: avg(army.yours[1], army.yours[0], 100),
      enemy_avg_hp_percent: avg(army.enemy[1], army.enemy[0], 100),
      your_avg_courage: avg(army.yours[2], army.yours[0]),
      enemy_avg_courage: avg(army.enemy[2], army.enemy[0]),
      your_fleeing: army.yours[3],
      enemy_fleeing: army.enemy[3],
      force_ratio_total_hp: formatRatio(forceRatio),
      force_ratio_at_last_report:
        memory.forceRatio === null ? 'n/a' : formatRatio(memory.forceRatio),
    },
    your_stray_soldiers: strays(sm, faction),
    enemy_stray_soldiers: strays(sm, enemyFaction),
    events_since_last_report: input.events.length ? input.events : ['none'],
    sectors: [...perSector.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sector, c]) => ({
        sector,
        yours: cellInfo(c.y),
        enemy: cellInfo(c.e),
        control:
          c.y[0] > 0 && c.y[0] >= 2 * c.e[0]
            ? 'yours'
            : c.e[0] > 0 && c.e[0] >= 2 * c.y[0]
              ? 'enemy'
              : 'contested',
      })),
    objective: objectiveReport(sm, faction),
    terrain_by_sector: terrainMap(sm),
  };

  const counted: ReportMemory = {
    forceRatio,
    soldiers: { yours: army.yours[0], enemy: army.enemy[0] },
    followers: new Map(
      heroes
        .filter((h) => mine(h.faction))
        .map((h) => [h.heroIndex, myGroups.get(h.id)?.followers ?? 0])
    ),
  };
  return { report, counted };
}

// D30: control points (holder, units near, scores, time left) or bases (HP, units near).
function objectiveReport(sm: StateManager, faction: Faction): unknown {
  const o = sm.getBattlefield().objective;
  const left = secondsLeft(sm);
  if (o.mode === 'control') {
    const scores = sideScores(sm, faction);
    return {
      mode: 'control points',
      your_points: wholePoints(scores.ours),
      enemy_points: wholePoints(scores.theirs),
      seconds_left: left,
      points: o.points.map((p) => {
        const c = pointCounts(sm, p);
        return {
          point: p.name,
          place: exactPlace(p.position),
          held_by: p.holder === null ? 'nobody' : p.holder === faction ? 'you' : 'enemy',
          // a side with the majority that does not hold it yet (CONTROL_CAPTURE_SECONDS)
          ...(p.leader !== null && p.leader !== p.holder
            ? { being_taken_by: p.leader === faction ? 'you' : 'enemy' }
            : {}),
          your_units_near: faction === Faction.FRIENDLY ? c.friendly : c.enemy,
          enemy_units_near: faction === Faction.FRIENDLY ? c.enemy : c.friendly,
        };
      }),
    };
  }
  if (o.mode === 'base') {
    const describe = (side: Faction) => {
      const b = o.bases.find((x) => x.faction === side);
      if (!b) return 'none';
      let attackers = 0;
      sm.forEachInRadius(b.position.x, b.position.y, 15, (u) => {
        if (u.hp > 0 && u.faction !== side) attackers++;
      });
      return {
        place: exactPlace(b.position),
        hp_percent: hpPercent(b),
        enemy_units_within_15_tiles: attackers,
      };
    };
    return {
      mode: 'destroy the base',
      seconds_left: left,
      your_base: describe(faction),
      enemy_base: describe(opponent(faction)),
    };
  }
  return { mode: 'elimination', seconds_left: left };
}

// Stray soldiers as clusters (D28): the 5 largest, the rest summed up.
function strays(sm: StateManager, faction: Faction): unknown {
  const clusters = strayClusters(sm, faction);
  if (clusters.length === 0) return 'none';
  const top = clusters.slice(0, MAX_STRAY_CLUSTERS).map((c) => ({
    place: positionToSubsector(c.center),
    soldiers: c.soldiers,
    avg_hp_percent: c.avgHpPercent,
    avg_courage: c.avgCourage,
    fleeing: c.fleeing,
  }));
  const rest = clusters.slice(MAX_STRAY_CLUSTERS).reduce((n, c) => n + c.soldiers, 0);
  return rest > 0 ? [...top, { other_strays_elsewhere: rest }] : top;
}

// Dominant terrain per sector, one row per grid row (north first), columns A-J.
function terrainMap(sm: StateManager): Record<string, unknown> {
  const grid = sm.getBattlefield().grid;
  const rows: string[] = [];
  for (let r = 0; r < SECTORS_PER_SIDE; r++) {
    let line = '';
    for (let c = 0; c < SECTORS_PER_SIDE; c++) {
      const counts = [0, 0, 0, 0];
      for (let y = r * SECTOR_SIZE; y < (r + 1) * SECTOR_SIZE; y++) {
        for (let x = c * SECTOR_SIZE; x < (c + 1) * SECTOR_SIZE; x++) counts[grid[y][x]]++;
      }
      // A sector counts as mountainous when a third of it is impassable.
      if (counts[TerrainType.MOUNTAIN] > (SECTOR_SIZE * SECTOR_SIZE) / 3) line += 'M';
      else {
        const top = [TerrainType.OPEN, TerrainType.FOREST, TerrainType.SWAMP].reduce((a, b) =>
          counts[b] > counts[a] ? b : a
        );
        line += top === TerrainType.FOREST ? 'f' : top === TerrainType.SWAMP ? 's' : '.';
      }
    }
    rows.push(`${r + 1}`.padStart(2) + ' ' + line);
  }
  return {
    legend: 'columns A-J west to east; . open, f forest, s swamp, M mostly mountains',
    rows,
  };
}
