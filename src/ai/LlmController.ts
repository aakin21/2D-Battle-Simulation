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
  failureInfo,
  transientStatus,
  unreachableStatus,
  FAILURES_IN_A_ROW,
} from './AiServer';
import { AiExchange, finishExchange, startExchange } from './Exchange';

const MAX_STRAY_CLUSTERS = 5;
const MAX_REASON = 300; // characters of an order's reason that are kept

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
  usage: LlmUsage | null; // cost and tokens of this answer, as the dev server reports them
}

// What one answer cost (Q11). Estimates from the Agent SDK, not a bill.
export interface LlmUsage {
  costUsd: number | null;
  inputTokens: number | null; // not counting cached input
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  apiMs: number | null; // time in API calls, part of latencyMs
  modelIds: string[]; // the full model ids behind the menu's alias
}

function usageOf(body: Record<string, unknown> | null): LlmUsage | null {
  if (!body) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const ids = Array.isArray(body.modelIds)
    ? body.modelIds.filter((m) => typeof m === 'string')
    : [];
  const usage: LlmUsage = {
    costUsd: num(body.costUsd),
    inputTokens: num(body.inputTokens),
    outputTokens: num(body.outputTokens),
    cacheReadTokens: num(body.cacheReadTokens),
    cacheWriteTokens: num(body.cacheWriteTokens),
    apiMs: num(body.apiMs),
    modelIds: ids as string[],
  };
  return Object.values(usage).some((v) => v !== null && !(Array.isArray(v) && v.length === 0))
    ? usage
    : null;
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
  reason?: unknown;
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
  // Not from Math.random: the simulation draws from it, and creating a controller must not
  // change the battle
  private readonly matchId = `match_${Date.now()}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  private readonly side: 'west' | 'east';
  readonly system: string; // the rulebook sent as the session's system prompt
  readonly decisions: LlmDecision[] = [];
  readonly exchanges: AiExchange[] = []; // every request with its answer (request log, match log)
  skippedRequests = 0;
  failedRequests = 0; // requests that failed but were tried again at the next report
  lastError: string | null = null; // the latest failed request's reason, until an answer comes
  private failuresInARow = 0;
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
    const { report, remember } = this.report(time);
    // The rulebook is the same in every request; the log keeps it once, in `system`
    const exchange = startExchange(this.exchanges, time, {
      side: this.side,
      matchId: this.matchId,
      model: this.opts.model,
      prompt: report,
    });
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
          prompt: JSON.stringify(report),
        }),
      });
      const latencyMs = performance.now() - started;
      if (this.disposed) return;
      if (!res.ok) {
        const info = await failureInfo(res);
        if (this.disposed) return;
        const reason = `HTTP ${res.status}${info.detail}`;
        finishExchange(exchange, latencyMs, null, reason);
        const retryable = !deniedByAiServer(res) && (info.retryable ?? transientStatus(res));
        if (retryable && this.tryAgainLater(reason)) return;
        this.fail(
          retryable ? `${reason} (${FAILURES_IN_A_ROW} failed requests in a row)` : reason,
          deniedByAiServer(res)
            ? AI_PASSWORD_HINT
            : res.status === 404 || res.status === 405
              ? 'This site has no LLM endpoint: run npm run dev, or open the demo through the tunnel (?ai=...).'
              : unreachableStatus(res.status)
                ? unreachableHint()
                : ''
        );
        return;
      }
      const body = (await res.json()) as Record<string, unknown> | null;
      if (this.disposed) return;
      finishExchange(exchange, latencyMs, body);
      remember();
      this.failuresInARow = 0;
      this.lastError = null;
      // A reply that is not text is applied as an empty one: "not valid JSON", layer goes on
      const text = typeof body?.text === 'string' ? body.text : '';
      const model = typeof body?.model === 'string' ? body.model : this.opts.model;
      this.apply(time, latencyMs, text, model, usageOf(body));
    } catch (err) {
      if (this.disposed) return;
      const reason = abort.signal.aborted
        ? `no answer within ${this.opts.timeoutMs / 1000} s`
        : String(err);
      if (exchange.latencyMs === null)
        finishExchange(exchange, performance.now() - started, null, reason);
      // A lost connection may come back (tunnel hiccup); no answer at all within the timeout
      // means the server is stuck, since it gives up and says so first
      if (abort.signal.aborted) this.fail(reason, '');
      else if (!this.tryAgainLater(reason))
        this.fail(`${reason} (${FAILURES_IN_A_ROW} failed requests in a row)`, unreachableHint());
    } finally {
      clearTimeout(timer);
      this.inFlight = null;
      this.pending = false;
    }
  }

  // Validates the LLM's reply and applies the usable orders through the command interface.
  private apply(
    time: number,
    latencyMs: number,
    text: string,
    model: string,
    usage: LlmUsage | null = null
  ): void {
    const d: LlmDecision = {
      usage,
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
      const parsed = this.toCommand(hero, raw);
      if (typeof parsed === 'string') {
        d.rejected.push(`hero ${hero.heroIndex}: ${parsed}`);
        continue;
      }
      // The order's reason travels with it: Jev reads it, the panel and the log show it
      const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, MAX_REASON) : '';
      const command: HeroCommand = reason ? { ...parsed, reason } : parsed;
      // Always issued, even if unchanged: the LLM's latest order wins when it arrives (D15).
      this.engine.issueCommand(hero, command, 'llm');
      d.orders.push(
        `hero ${hero.heroIndex}: ${this.describe(command)}${reason ? ` (${reason})` : ''}`
      );
    }
  }

  // Returns a command, or a reason why the order cannot be used.
  private toCommand(hero: IHero, raw: RawOrder): HeroCommand | string {
    // Written by the model: case and outer spaces do not matter ("Move", " regroup ")
    const command =
      typeof raw.command === 'string' ? raw.command.trim().toLowerCase() : raw.command;
    switch (command) {
      case 'move': {
        const place = typeof raw.place === 'string' ? raw.place : raw.sector;
        // "A", or "point A" as the report names it (way_to_objectives)
        const pointName =
          typeof place === 'string'
            ? place
                .trim()
                .toUpperCase()
                .replace(/^POINT\s+/, '')
            : '';
        const point = this.stateManager
          .getBattlefield()
          .objective.points.find((p) => p.name === pointName);
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

  // A request that may work next time (overloaded, rate limited, a lost connection) is counted
  // and asked again at the next report, as the CLI behind the endpoint has already retried it;
  // only several failures in a row stop the layer.
  private tryAgainLater(reason: string): boolean {
    this.failedRequests++;
    this.failuresInARow++;
    this.lastError = reason;
    if (this.failuresInARow >= FAILURES_IN_A_ROW) return false;
    console.warn(`LLM (${this.side}) request failed (${reason}); asking again at the next report.`);
    return true;
  }

  private fail(reason: string, hint: string): void {
    this.failed = true;
    if (this.opts.fallbackToRules) for (const hero of this.myHeroes()) hero.controller = 'rule';
    const what = this.opts.fallbackToRules
      ? 'heroes switched to rule-based control'
      : 'strategic layer stopped';
    // The hint says what to do; it is shown in the AI panel and kept in the match log
    this.failure = hint ? `${reason}; ${what}. ${hint}` : `${reason}; ${what}`;
    console.warn(`LLM (${this.side}) unavailable (${reason}); ${what}. ${hint}`);
  }

  // The whole battlefield as computed values (R5, D26).
  private report(time: number): { report: Record<string, unknown>; remember: () => void } {
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
              ? `${this.describe(h.command)} (from ${h.commandSource}${h.command.reason ? `: ${h.command.reason}` : ''})`
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

    // What the next report compares with, kept only once this report has reached the LLM
    // (remember() is called when its answer arrives): after a failed request the next report
    // still carries these events and counts its changes from the last report the LLM saw.
    const sentEvents = this.events.length;
    const followers = new Map(
      heroes
        .filter((h) => mine(h.faction))
        .map((h) => [h.heroIndex, myGroups.get(h.id)?.followers ?? 0])
    );
    const remember = () => {
      this.lastForceRatio = forceRatio;
      this.lastSoldiers = { yours: army.yours[0], enemy: army.enemy[0] };
      this.lastFollowers = followers;
      this.events.splice(0, sentEvents); // events noted while waiting stay for the next one
    };
    return { report, remember };
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
        return 'retreat a short way from the enemies';
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
