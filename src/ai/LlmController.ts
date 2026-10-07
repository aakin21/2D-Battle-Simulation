import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import {
  positionToSector,
  positionToSubsector,
  sectorTarget,
  SECTORS_PER_SIDE,
  SECTOR_SIZE,
} from '../engine/Sectors';
import {
  Faction,
  IHero,
  HeroCommand,
  BehaviorState,
  TerrainType,
  UnitType,
  LlmModel,
} from '../types/types';
import { llmSystemPrompt } from './GameRules';
import {
  armyHp,
  exactPlace,
  formatRatio,
  groupStats,
  localForce,
  objectivePlaces,
  wayToObjectives,
} from './Observations';
import { strayClusters } from '../engine/Strays';
import { enemyBase, pointCounts } from '../engine/Objectives';
import {
  aiEndpoint,
  aiHeaders,
  deniedByAiServer,
  AI_PASSWORD_HINT,
  unreachableHint,
} from './AiServer';

const MAX_STRAY_CLUSTERS = 5;

// Layer 3 (D1, D10): the LLM plans the overall strategy every 20 s from a computed summary
// of the whole map (D16, R5). It runs in the dev server through the Claude Agent SDK.

export type Stance = 'aggressive' | 'defensive' | 'regroup';

export interface LlmDecision {
  time: number; // simulation time when the request was sent
  model: string; // the model that answered
  latencyMs: number;
  situation: string;
  change: string;
  stance: Stance | '';
  plan: string;
  orders: string[]; // orders that were valid and applied, e.g. "hero 1: move D4-NE"
  rejected: string[]; // orders that could not be used, with the reason
  raw: string;
}

// What Jev reports upward about one hero (R5: lower layers report to the commander).
export interface JevAssessment {
  recentDecisions: string[];
  surrounded?: number; // 0–1
  threat?: number; // 0–3
  orderStillFits?: number; // 0–1
}

export interface LlmOptions {
  intervalSec: number;
  fallbackToRules: boolean; // on failure, hand heroes to the rule layer (when the LLM is the only AI layer)
  endpoint: string;
  fetchFn: typeof fetch;
  jevAssessment: ((heroIndex: number) => JevAssessment) | null; // set when Jev runs on the same side
  model: LlmModel;
  timeoutMs: number; // a request without an answer by then counts as a failure
}

const DEFAULTS: LlmOptions = {
  intervalSec: 20,
  fallbackToRules: true,
  endpoint: aiEndpoint('/api/llm'),
  fetchFn: (...args) => fetch(...args),
  jevAssessment: null,
  model: 'sonnet',
  timeoutMs: 120_000,
};

interface RawOrder {
  hero?: unknown;
  command?: unknown;
  place?: unknown;
  sector?: unknown;
  target_hero?: unknown;
}

export class LlmController {
  private opts: LlmOptions;
  private nextAt = 0;
  private pending = false;
  private failed = false;
  private readonly matchId = `match_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  private readonly side: 'west' | 'east';
  readonly system: string; // the rulebook sent as the session's system prompt
  readonly decisions: LlmDecision[] = [];
  skippedRequests = 0;
  failure: string | null = null; // why the layer stopped, for the AI panel and the match log
  private disposed = false;
  private inFlight: AbortController | null = null;

  // Memory between reports
  private lastForceRatio: number | null = null;
  private lastFollowers = new Map<number, number>();
  private lastSoldiers: { yours: number; enemy: number } | null = null;
  private events: string[] = [];
  private heroAlive = new Map<string, IHero>();
  private heroFleeing = new Set<string>();

  constructor(
    private engine: SimulationEngine,
    private stateManager: StateManager,
    private faction: Faction,
    opts: Partial<LlmOptions> = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.side = faction === Faction.FRIENDLY ? 'west' : 'east';
    this.system = llmSystemPrompt(
      this.side,
      this.opts.jevAssessment !== null,
      this.opts.intervalSec,
      stateManager.getBattlefield().objective.mode
    );
  }

  isWaiting(): boolean {
    return this.pending;
  }

  // The match ended or restarted: no more requests, and a late answer is dropped.
  dispose(): void {
    this.disposed = true;
    this.inFlight?.abort();
  }

  tick(elapsed: number): void {
    this.watchEvents(elapsed);
    if (this.failed || this.disposed || elapsed < this.nextAt) return;
    this.nextAt = elapsed + this.opts.intervalSec;
    if (this.pending) {
      this.skippedRequests++;
      return;
    }
    void this.decide(elapsed);
  }

  // Notes hero deaths and survival-reflex retreats as they happen, for the next report.
  private watchEvents(elapsed: number): void {
    const t = Math.round(elapsed);
    const current = new Map(this.stateManager.getHeroes().map((h) => [h.id, h]));
    for (const [id, h] of this.heroAlive) {
      if (!current.has(id))
        this.events.push(`t=${t}s ${this.owner(h)} hero ${h.heroIndex} was killed`);
    }
    for (const h of current.values()) {
      const fleeing = h.state === BehaviorState.FLEE;
      if (fleeing && !this.heroFleeing.has(h.id)) {
        this.events.push(
          `t=${t}s ${this.owner(h)} hero ${h.heroIndex} started retreating (survival reflex, ${this.pct(h)}% HP)`
        );
        this.heroFleeing.add(h.id);
      } else if (!fleeing) this.heroFleeing.delete(h.id);
    }
    this.heroAlive = current;
  }

  private owner(h: IHero): string {
    return h.faction === this.faction ? 'your' : 'enemy';
  }

  private pct(h: IHero): number {
    return Math.round((100 * h.hp) / h.maxHp);
  }

  private myHeroes(): IHero[] {
    return this.stateManager
      .getHeroes()
      .filter((h) => h.faction === this.faction && h.hp > 0 && h.controller === 'ai');
  }

  private async decide(time: number): Promise<void> {
    const heroes = this.myHeroes();
    if (heroes.length === 0) return;

    this.pending = true;
    const started = performance.now();
    // An answer that never comes would block the layer, and in paused mode the whole battle
    const abort = new AbortController();
    this.inFlight = abort;
    const timer = setTimeout(() => abort.abort(), this.opts.timeoutMs);
    try {
      const res = await this.opts.fetchFn(this.opts.endpoint, {
        method: 'POST',
        headers: aiHeaders(),
        signal: abort.signal,
        body: JSON.stringify({
          side: this.side,
          matchId: this.matchId,
          system: this.system,
          model: this.opts.model,
          prompt: JSON.stringify(this.report(time)),
        }),
      });
      const latencyMs = performance.now() - started;
      if (this.disposed) return;
      if (!res.ok) {
        this.fail(
          `HTTP ${res.status}`,
          deniedByAiServer(res)
            ? AI_PASSWORD_HINT
            : res.status === 404 || res.status === 405
              ? 'This site has no LLM endpoint: run npm run dev, or open the demo through the tunnel (?ai=...).'
              : ''
        );
        return;
      }
      const { text, model } = (await res.json()) as { text: string; model?: string };
      if (this.disposed) return;
      this.apply(time, latencyMs, text ?? '', model ?? this.opts.model);
    } catch (err) {
      if (this.disposed) return;
      if (abort.signal.aborted) this.fail(`no answer within ${this.opts.timeoutMs / 1000} s`, '');
      else this.fail(String(err), unreachableHint());
    } finally {
      clearTimeout(timer);
      this.inFlight = null;
      this.pending = false;
    }
  }

  // Validates the LLM's reply and applies the usable orders through the command interface.
  private apply(time: number, latencyMs: number, text: string, model: string): void {
    const d: LlmDecision = {
      time,
      model,
      latencyMs,
      situation: '',
      change: '',
      stance: '',
      plan: '',
      orders: [],
      rejected: [],
      raw: text,
    };
    this.decisions.push(d);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch {
      d.rejected.push('reply was not valid JSON');
      return;
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    d.situation = str(parsed.situation);
    d.change = str(parsed.change);
    d.plan = str(parsed.plan);
    const stance = str(parsed.stance);
    if (stance === 'aggressive' || stance === 'defensive' || stance === 'regroup')
      d.stance = stance;
    else d.rejected.push(`unknown stance ${stance || '(none)'}`);

    if (!Array.isArray(parsed.orders)) {
      d.rejected.push('no "orders" list');
      return;
    }
    for (const entry of parsed.orders as unknown[]) {
      // One malformed entry must not stop the layer: skip it with a reason
      if (!entry || typeof entry !== 'object') {
        d.rejected.push(`order is not an object: ${JSON.stringify(entry)}`);
        continue;
      }
      const raw = entry as RawOrder;
      const hero = this.myHeroes().find((h) => h.heroIndex === Number(raw.hero));
      if (!hero) {
        d.rejected.push(`unknown or dead hero ${String(raw.hero)}`);
        continue;
      }
      const command = this.toCommand(hero, raw);
      if (typeof command === 'string') {
        d.rejected.push(`hero ${hero.heroIndex}: ${command}`);
        continue;
      }
      // Always issued, even if unchanged: the LLM's latest order wins when it arrives (D15).
      this.engine.issueCommand(hero, command, 'llm');
      d.orders.push(`hero ${hero.heroIndex}: ${this.describe(command)}`);
    }
  }

  // Returns a command, or a reason why the order cannot be used.
  private toCommand(hero: IHero, raw: RawOrder): HeroCommand | string {
    switch (raw.command) {
      case 'move': {
        const place = typeof raw.place === 'string' ? raw.place : raw.sector;
        const point = this.stateManager
          .getBattlefield()
          .objective.points.find(
            (p) => typeof place === 'string' && p.name === place.trim().toUpperCase()
          );
        const target = point
          ? point.position
          : typeof place === 'string'
            ? sectorTarget(place)
            : null;
        return target ? { type: 'move', target } : `invalid place ${String(place)}`;
      }
      case 'hold':
        return {
          type: 'hold',
          at: { x: Math.floor(hero.position.x), y: Math.floor(hero.position.y) },
        };
      case 'retreat':
        return { type: 'retreat' };
      case 'attack':
        return { type: 'attack' };
      case 'regroup':
        return { type: 'regroup' };
      case 'attack_base':
        return enemyBase(this.stateManager, hero.faction)
          ? { type: 'attackBase' }
          : 'there is no enemy base in this mode';
      case 'attack_hero': {
        const index = Number(raw.target_hero);
        const alive = this.stateManager
          .getHeroes()
          .some((h) => h.faction !== hero.faction && h.heroIndex === index && h.hp > 0);
        return alive
          ? { type: 'attackHero', heroIndex: index }
          : `enemy hero ${String(raw.target_hero)} does not exist or is dead`;
      }
      default:
        return `unknown command ${String(raw.command)}`;
    }
  }

  private fail(reason: string, hint: string): void {
    this.failed = true;
    if (this.opts.fallbackToRules) for (const hero of this.myHeroes()) hero.controller = 'rule';
    const what = this.opts.fallbackToRules
      ? 'heroes switched to rule-based control'
      : 'strategic layer stopped';
    this.failure = `${reason}; ${what}`;
    console.warn(`LLM (${this.side}) unavailable (${reason}); ${what}. ${hint}`);
  }

  // The whole battlefield as computed values (R5, D26).
  private report(time: number): Record<string, unknown> {
    const sm = this.stateManager;
    const mine = (f: Faction) => f === this.faction;
    const heroes = sm.getHeroes().filter((h) => h.hp > 0);
    const myGroups = groupStats(sm, this.faction);
    const enemyFaction = this.faction === Faction.FRIENDLY ? Faction.ENEMY : Faction.FRIENDLY;
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

    const last = this.decisions[this.decisions.length - 1];
    const objectives = objectivePlaces(sm, this.faction, 'your');
    const report = {
      time_seconds: Math.round(time),
      your_previous_decision: last
        ? { stance: last.stance, plan: last.plan, seconds_ago: Math.round(time - last.time) }
        : 'none (first report)',
      your_groups: heroes
        .filter((h) => mine(h.faction))
        .map((h) => {
          const g = myGroups.get(h.id);
          const jev = this.opts.jevAssessment?.(h.heroIndex);
          const prev = this.lastFollowers.get(h.heroIndex);
          return {
            hero: h.heroIndex,
            place: positionToSubsector(h.position),
            hero_hp_percent: this.pct(h),
            hero_status: this.status(h),
            current_order: h.command
              ? `${this.describe(h.command)} (from ${h.commandSource})`
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
            hero_hp_percent: this.pct(h),
            hero_status: this.status(h),
            soldiers_following: g?.followers ?? 0,
            soldiers_avg_hp_percent: g?.avgHpPercent ?? 0,
            soldiers_avg_courage: g?.avgCourage ?? 0,
            soldiers_fleeing: g?.fleeing ?? 0,
          };
        }),
      armies: {
        your_soldiers: army.yours[0],
        enemy_soldiers: army.enemy[0],
        your_soldiers_lost_since_last_report: this.lastSoldiers
          ? this.lastSoldiers.yours - army.yours[0]
          : 'n/a',
        enemy_soldiers_lost_since_last_report: this.lastSoldiers
          ? this.lastSoldiers.enemy - army.enemy[0]
          : 'n/a',
        your_avg_hp_percent: avg(army.yours[1], army.yours[0], 100),
        enemy_avg_hp_percent: avg(army.enemy[1], army.enemy[0], 100),
        your_avg_courage: avg(army.yours[2], army.yours[0]),
        enemy_avg_courage: avg(army.enemy[2], army.enemy[0]),
        your_fleeing: army.yours[3],
        enemy_fleeing: army.enemy[3],
        force_ratio_total_hp: formatRatio(forceRatio),
        force_ratio_at_last_report:
          this.lastForceRatio === null ? 'n/a' : formatRatio(this.lastForceRatio),
      },
      your_stray_soldiers: this.strays(this.faction),
      enemy_stray_soldiers: this.strays(enemyFaction),
      events_since_last_report: this.events.length ? this.events : ['none'],
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
      objective: this.objectiveReport(),
      terrain_by_sector: this.terrainMap(),
    };

    // Remember for the next report
    this.lastForceRatio = forceRatio;
    this.lastSoldiers = { yours: army.yours[0], enemy: army.enemy[0] };
    this.lastFollowers = new Map(
      heroes
        .filter((h) => mine(h.faction))
        .map((h) => [h.heroIndex, myGroups.get(h.id)?.followers ?? 0])
    );
    this.events = [];
    return report;
  }

  // D30: control points (holder, units near, scores, time left) or bases (HP, units near).
  private objectiveReport(): unknown {
    const bf = this.stateManager.getBattlefield();
    const o = bf.objective;
    const mineF = this.faction;
    const secondsLeft =
      o.timeLimit === null ? 'n/a' : Math.max(0, Math.round(o.timeLimit - bf.elapsedTime));
    if (o.mode === 'control') {
      const yours = mineF === Faction.FRIENDLY ? o.scores.friendly : o.scores.enemy;
      const theirs = mineF === Faction.FRIENDLY ? o.scores.enemy : o.scores.friendly;
      return {
        mode: 'control points',
        your_points: Math.round(yours),
        enemy_points: Math.round(theirs),
        seconds_left: secondsLeft,
        points: o.points.map((p) => {
          const c = pointCounts(this.stateManager, p);
          return {
            point: p.name,
            place: exactPlace(p.position),
            held_by: p.holder === null ? 'nobody' : p.holder === mineF ? 'you' : 'enemy',
            your_units_near: mineF === Faction.FRIENDLY ? c.friendly : c.enemy,
            enemy_units_near: mineF === Faction.FRIENDLY ? c.enemy : c.friendly,
          };
        }),
      };
    }
    if (o.mode === 'base') {
      const describe = (faction: Faction) => {
        const b = o.bases.find((x) => x.faction === faction);
        if (!b) return 'none';
        let attackers = 0;
        this.stateManager.forEachInRadius(b.position.x, b.position.y, 15, (u) => {
          if (u.hp > 0 && u.faction !== faction) attackers++;
        });
        return {
          place: exactPlace(b.position),
          hp_percent: Math.round((100 * b.hp) / b.maxHp),
          enemy_units_within_15_tiles: attackers,
        };
      };
      const enemyF = mineF === Faction.FRIENDLY ? Faction.ENEMY : Faction.FRIENDLY;
      return {
        mode: 'destroy the base',
        seconds_left: secondsLeft,
        your_base: describe(mineF),
        enemy_base: describe(enemyF),
      };
    }
    return { mode: 'elimination', seconds_left: secondsLeft };
  }

  // Stray soldiers as clusters (D28): the 5 largest, the rest summed up.
  private strays(faction: Faction): unknown {
    const clusters = strayClusters(this.stateManager, faction);
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
  private terrainMap(): Record<string, unknown> {
    const grid = this.stateManager.getBattlefield().grid;
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

  private status(h: IHero): string {
    switch (h.state) {
      case BehaviorState.ATTACK:
        return 'fighting';
      case BehaviorState.FLEE:
        return 'retreating (survival reflex)';
      case BehaviorState.REST:
        return 'resting';
      default:
        return h.path.length > 0 ? 'moving' : 'standing';
    }
  }

  private describe(c: HeroCommand): string {
    switch (c.type) {
      case 'move':
        return `move ${positionToSubsector(c.target)}`;
      case 'hold':
        return `hold in ${positionToSubsector(c.at)}`;
      case 'retreat':
        return 'retreat';
      case 'attack':
        return 'attack nearest enemy';
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
}
