import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { positionToSubsector } from '../engine/Sectors';
import {
  Faction,
  IHero,
  IUnit,
  HeroCommand,
  BehaviorState,
  TerrainType,
  GRID_SIZE,
} from '../types/types';
import { jevGameRules } from './GameRules';
import {
  compass,
  COMPASS,
  exactPlace,
  formatRatio,
  groupStats,
  localForce,
  LOCAL_RADIUS,
} from './Observations';
import type { JevAssessment } from './LlmController';
import { strayClusters, regroupTarget } from '../engine/Strays';
import { enemyBase } from '../engine/Objectives';
import {
  aiEndpoint,
  aiHeaders,
  deniedByAiServer,
  AI_PASSWORD_HINT,
  unreachableHint,
  failureInfo,
  fetchWithRetries,
  transientStatus,
  unreachableStatus,
  FAILURES_IN_A_ROW,
} from './AiServer';
import { AiExchange, finishExchange, startExchange } from './Exchange';

// Layer 2 (D6, D21, D26): Jev makes tactical decisions for each hero of one side every few
// seconds. Jev has no memory, so every request carries the relevant rules (game_rules) and
// each hero's surroundings (D16). For each hero Jev picks one option from a list we define,
// and answers three small assessment questions that are logged and reported to the LLM.

export interface JevDecision {
  time: number; // simulation time when the request was sent
  heroIndex: number;
  choice: string;
  confidence: number;
  applied: boolean; // false when confidence was below the threshold
  latencyMs: number;
  surrounded?: number;
  threat?: number;
  orderStillFits?: number;
  model?: string; // the Jev version that answered (the request asks for jev-latest)
  inputTokens?: number; // of the whole request, shared by its heroes
  attempts?: number; // more than 1 when the request was retried
}

export interface JevOptions {
  intervalSec: number; // how often to ask (3–5 s, D1)
  minConfidence: number; // below this the hero keeps its current command
  fallbackToRules: boolean; // on failure, hand heroes to the rule layer (when Jev is the only AI layer)
  withCommander: boolean; // an LLM commands the same side (changes Jev's role and goal)
  endpoint: string;
  fetchFn: typeof fetch;
  timeoutMs: number; // a request without an answer by then counts as a failure
}

const DEFAULTS: JevOptions = {
  intervalSec: 4,
  minConfidence: 0.4,
  fallbackToRules: true,
  withCommander: false,
  endpoint: aiEndpoint('/api/jev'),
  fetchFn: (...args) => fetch(...args),
  timeoutMs: 30_000,
};

const MAP_CELL = 2; // local map: one character per 2×2 tiles
const STEP_TILES = 10; // length of a "step" move
const HERO_SCAN = LOCAL_RADIUS * 2; // enemy heroes within this distance can be targeted
const STRAY_REACH = 25; // stray groups within this distance are shown to Jev
const MAX_REQUEST_CHARS = 100_000;

interface Option {
  key: string;
  what: string;
  notFor: string;
  command: HeroCommand;
}

export class JevController {
  private opts: JevOptions;
  private nextAt = 0;
  private pending = false;
  private failed = false;
  readonly decisions: JevDecision[] = [];
  readonly exchanges: AiExchange[] = []; // every request with its answer (request log, match log)
  failedRequests = 0; // requests that failed but were not the last straw
  lastError: string | null = null; // the latest failed request's reason, until an answer comes
  private failuresInARow = 0;
  skippedRequests = 0; // a new request was due while the previous one was still open (Q7)
  failure: string | null = null; // why the layer stopped, for the AI panel and the match log
  private disposed = false;
  private inFlight: AbortController | null = null;
  private lastForce = new Map<number, number>(); // force ratio per hero at the previous request
  private lastChoice = new Map<number, string>();
  private assessments = new Map<number, Omit<JevAssessment, 'recentDecisions'>>();

  constructor(
    private engine: SimulationEngine,
    private stateManager: StateManager,
    private faction: Faction,
    opts: Partial<JevOptions> = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  isWaiting(): boolean {
    return this.pending;
  }

  // The match ended or restarted: no more requests, and a late answer is dropped.
  dispose(): void {
    this.disposed = true;
    this.inFlight?.abort();
  }

  // Called by the engine every simulation step.
  tick(elapsed: number): void {
    if (this.failed || this.disposed || elapsed < this.nextAt) return;
    this.nextAt = elapsed + this.opts.intervalSec;
    if (this.pending) {
      this.skippedRequests++;
      return;
    }
    void this.decide(elapsed);
  }

  // The last few applied decisions for one hero, oldest first (shown to the LLM, D15).
  recentFor(heroIndex: number, count = 3): string[] {
    return this.decisions
      .filter((d) => d.heroIndex === heroIndex && d.applied)
      .slice(-count)
      .map((d) => `t=${Math.round(d.time)}s ${d.choice}`);
  }

  // What Jev reports upward about one hero (R5).
  assessmentFor(heroIndex: number): JevAssessment {
    return { recentDecisions: this.recentFor(heroIndex), ...this.assessments.get(heroIndex) };
  }

  private heroes(): IHero[] {
    return this.stateManager
      .getHeroes()
      .filter((h) => h.faction === this.faction && h.hp > 0 && h.controller === 'ai');
  }

  private async decide(time: number): Promise<void> {
    const heroes = this.heroes();
    if (heroes.length === 0) return;

    const groups = groupStats(this.stateManager, this.faction);
    const options = new Map<number, Option[]>();
    const forceNow = new Map<number, number>();
    const questions: Record<string, unknown> = {};
    const state: Record<string, unknown> = {
      game_rules: jevGameRules(
        this.opts.withCommander,
        this.stateManager.getBattlefield().objective.mode
      ),
      objective: this.objectiveState(),
      time_seconds: Math.round(time),
      your_side: this.faction === Faction.FRIENDLY ? 'west' : 'east',
    };

    for (const hero of heroes) {
      const key = `hero${hero.heroIndex}`;
      const opts = this.optionsFor(hero);
      options.set(hero.heroIndex, opts);
      const force = localForce(this.stateManager, hero);
      forceNow.set(hero.heroIndex, force.ratio);
      state[key] = this.describeHero(hero, time, force, groups.get(hero.id));

      questions[key] = {
        type: 'choice',
        instructions: { hero: key, question: `What should \`${key}\` do right now?` },
        criteria: Object.fromEntries(opts.map((o) => [o.key, { what: o.what, not_for: o.notFor }])),
      };
      questions[`${key}_surrounded`] = {
        type: 'noul',
        instructions: `Is \`${key}\` being surrounded: enemies on several sides and its way back closing?`,
      };
      questions[`${key}_threat`] = {
        type: 'score',
        instructions: `How dangerous is the situation around \`${key}\` right now?`,
        criteria: [
          'Safe: no enemies near',
          'Low: enemies near, but we are clearly stronger here',
          'High: enemies about as strong as us or stronger here',
          'Critical: the hero is about to die or lose its soldiers',
        ],
      };
      if (hero.lastLlmCommand) {
        questions[`${key}_order_fits`] = {
          type: 'noul',
          instructions: `Does the commander's order for \`${key}\` (${this.describeCommand(hero.lastLlmCommand)}) still make sense in its current situation?`,
        };
      }
    }

    const request = { model: 'jev-latest', state, questions };
    const body = JSON.stringify(request);
    const exchange = startExchange(this.exchanges, time, request);
    // Far above a normal request (~13 KB); the deployed proxy refuses more (api/jev.ts)
    if (body.length > MAX_REQUEST_CHARS) {
      const reason = `request too large (${Math.round(body.length / 1024)} KB)`;
      finishExchange(exchange, 0, null, reason);
      this.fail(reason, '');
      return;
    }

    this.pending = true;
    const started = performance.now();
    // An answer that never comes would block the layer, and in paused mode the whole battle
    const abort = new AbortController();
    this.inFlight = abort;
    const timer = setTimeout(() => abort.abort(), this.opts.timeoutMs);
    try {
      const { res, attempts } = await fetchWithRetries(this.opts.fetchFn, this.opts.endpoint, {
        method: 'POST',
        headers: aiHeaders(),
        signal: abort.signal,
        body,
      });
      const latencyMs = performance.now() - started;
      if (this.disposed) return;

      if (!res.ok) {
        const info = await failureInfo(res);
        if (this.disposed) return;
        const reason = `HTTP ${res.status}${info.detail}${attempts > 1 ? ` after ${attempts} tries` : ''}`;
        finishExchange(exchange, latencyMs, null, reason);
        exchange.attempts = attempts;
        const retryable = transientStatus(res);
        if (retryable && this.tryAgainLater(reason)) return;
        this.fail(
          retryable ? `${reason} (${FAILURES_IN_A_ROW} failed requests in a row)` : reason,
          deniedByAiServer(res)
            ? AI_PASSWORD_HINT
            : res.status === 401 || res.status === 403
              ? 'Set TYPESAFE_API_KEY in .env.local and restart the dev server.'
              : unreachableStatus(res.status)
                ? unreachableHint()
                : ''
        );
        return;
      }

      const answer = (await res.json()) as {
        model?: unknown;
        usage?: { input_tokens?: unknown };
        answers?: Record<
          string,
          { choice?: string; confidence?: number; score?: number; noul?: number }
        >;
      } | null;
      if (this.disposed) return;
      finishExchange(exchange, latencyMs, answer);
      exchange.attempts = attempts;
      this.failuresInARow = 0;
      this.lastError = null;
      const model = typeof answer?.model === 'string' ? answer.model : undefined;
      const inputTokens = num(answer?.usage?.input_tokens);
      const a = answer?.answers ?? {};
      for (const hero of heroes) {
        const key = `hero${hero.heroIndex}`;
        const assessment = {
          surrounded: num(a[`${key}_surrounded`]?.noul),
          threat: num(a[`${key}_threat`]?.score),
          orderStillFits: num(a[`${key}_order_fits`]?.noul),
        };
        this.assessments.set(hero.heroIndex, assessment);
        this.lastForce.set(hero.heroIndex, forceNow.get(hero.heroIndex) ?? Infinity);

        const choice = a[key];
        const option = options.get(hero.heroIndex)?.find((o) => o.key === choice?.choice);
        if (!choice || !option || hero.hp <= 0) continue;

        const confidence = num(choice.confidence) ?? 0;
        const applied = confidence >= this.opts.minConfidence;
        // A repeated order is ignored by the command interface (D27).
        if (applied) this.engine.issueCommand(hero, option.command, 'jev');
        if (applied) this.lastChoice.set(hero.heroIndex, option.key);
        this.decisions.push({
          time,
          heroIndex: hero.heroIndex,
          choice: option.key,
          confidence,
          applied,
          latencyMs,
          ...assessment,
          model,
          inputTokens,
          attempts,
        });
      }
    } catch (err) {
      if (this.disposed) return;
      const reason = abort.signal.aborted
        ? `no answer within ${this.opts.timeoutMs / 1000} s`
        : String(err);
      if (exchange.latencyMs === null)
        finishExchange(exchange, performance.now() - started, null, reason);
      // Lost connections were already retried twice; the next request may still get through.
      // No answer within the whole time budget stops the layer, as in paused mode it holds the
      // battle.
      if (abort.signal.aborted) this.fail(reason, '');
      else if (!this.tryAgainLater(reason))
        this.fail(`${reason} (${FAILURES_IN_A_ROW} failed requests in a row)`, unreachableHint());
    } finally {
      clearTimeout(timer);
      this.inFlight = null;
      this.pending = false;
    }
  }

  // A request that may work next time (rate limited, overloaded, a lost connection), even after
  // the retries within it, is counted and the next one goes out as usual; only several failures
  // in a row stop the layer.
  private tryAgainLater(reason: string): boolean {
    this.failedRequests++;
    this.failuresInARow++;
    this.lastError = reason;
    if (this.failuresInARow >= FAILURES_IN_A_ROW) return false;
    console.warn(`Jev request failed (${reason}); asking again at the next decision.`);
    return true;
  }

  // Jev is unavailable: stop asking. If no other AI layer commands these heroes, hand them
  // back to the rule layer so the game goes on.
  private fail(reason: string, hint: string): void {
    this.failed = true;
    if (this.opts.fallbackToRules) for (const hero of this.heroes()) hero.controller = 'rule';
    const what = this.opts.fallbackToRules
      ? 'heroes switched to rule-based control'
      : 'tactical layer stopped';
    // The hint says what to do; it is shown in the AI panel and kept in the match log
    this.failure = hint ? `${reason}; ${what}. ${hint}` : `${reason}; ${what}`;
    console.warn(`Jev unavailable (${reason}); ${what}. ${hint}`);
  }

  // The options Jev can choose from for one hero (D20, D26), each with what it is for and
  // what it is not for. Moves are short steps: Jev decides locally, the LLM moves map-wide.
  private optionsFor(hero: IHero): Option[] {
    const here = { x: Math.floor(hero.position.x), y: Math.floor(hero.position.y) };
    const opts: Option[] = [];

    if (hero.lastLlmCommand) {
      opts.push({
        key: 'continue_llm',
        what: `Keep following the commander's order: ${this.describeCommand(hero.lastLlmCommand)}.`,
        notFor: 'When the hero is in danger or the order no longer fits the local situation.',
        command: { type: 'continueLlm' },
      });
    }
    opts.push(
      {
        key: 'hold',
        what: 'Stay at the current position and fight what comes.',
        notFor:
          'When clearly outnumbered and losing, or when enemies are slipping around the group.',
        command: { type: 'hold', at: here },
      },
      {
        key: 'retreat',
        what: 'Fall back to the start position, away from the enemy, to save the hero and its soldiers.',
        notFor: 'When winning the local fight or when the enemy is weak.',
        command: { type: 'retreat' },
      },
      {
        key: 'attack',
        what: 'Advance on the nearest enemy unit.',
        notFor: 'When the enemy is clearly stronger nearby or the soldiers are fleeing.',
        command: { type: 'attack' },
      }
    );

    for (const enemy of this.stateManager.getHeroes()) {
      if (enemy.faction === hero.faction || enemy.hp <= 0) continue;
      const d = Math.hypot(enemy.position.x - hero.position.x, enemy.position.y - hero.position.y);
      if (d > HERO_SCAN) continue;
      opts.push({
        key: `attack_hero_${enemy.heroIndex}`,
        what: `Chase enemy hero ${enemy.heroIndex} (${Math.round(d)} tiles ${this.direction(hero, enemy)}, ${Math.round((100 * enemy.hp) / enemy.maxHp)}% HP); killing it takes away its soldiers' courage bonus.`,
        notFor: 'When that hero is protected by a stronger group, or our own hero is badly hurt.',
        command: { type: 'attackHero', heroIndex: enemy.heroIndex },
      });
    }

    const objective = this.stateManager.getBattlefield().objective;
    for (const p of objective.points) {
      const d = Math.round(
        Math.hypot(p.position.x - hero.position.x, p.position.y - hero.position.y)
      );
      const held = p.holder === null ? 'nobody' : p.holder === hero.faction ? 'us' : 'the enemy';
      opts.push({
        key: `move_to_${p.name}`,
        what: `Go to control point ${p.name} (${d} tiles to the ${compass(hero.position, p.position)}, held by ${held} now) and stay; the side with more units there scores.`,
        notFor:
          'When the hero is needed in the fight it is in, or the point is held strongly by the enemy.',
        command: { type: 'move', target: p.position },
      });
    }
    const target = enemyBase(this.stateManager, hero.faction);
    if (target && target.hp > 0) {
      const d = Math.round(
        Math.hypot(target.position.x - hero.position.x, target.position.y - hero.position.y)
      );
      opts.push({
        key: 'attack_base',
        what: `March on the enemy base (${d} tiles to the ${compass(hero.position, target.position)}, ${Math.round((100 * target.hp) / target.maxHp)}% HP) and attack it.`,
        notFor: 'When enemy units nearby are stronger, or our own base is under attack.',
        command: { type: 'attackBase' },
      });
    }

    // Offered when strays are near; described by the group the order actually leads to, which
    // can be a bigger group farther away (regroupTarget weighs distance by group size)
    const goal =
      this.nearbyStrays(hero).length > 0
        ? regroupTarget(strayClusters(this.stateManager, hero.faction), hero)
        : null;
    if (goal) {
      const d = Math.round(
        Math.hypot(goal.center.x - hero.position.x, goal.center.y - hero.position.y)
      );
      opts.push({
        key: 'regroup',
        what: `Collect stray soldiers of our side: this order leads to a group of ${goal.soldiers} soldiers, ${d} tiles to the ${compass(hero.position, goal.center)} (a bigger group is preferred to a nearer small one); they follow the hero again and regain its courage bonus.`,
        notFor: 'When the hero is in a fight it is winning, or the strays are far away.',
        command: { type: 'regroup' },
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
    return opts;
  }

  // Everything Jev knows about one hero: its status, orders and surroundings (D16, D26).
  private describeHero(
    hero: IHero,
    time: number,
    force: { allies: number; enemies: number; ratio: number },
    group:
      | { followers: number; avgHpPercent: number; avgCourage: number; fleeing: number }
      | undefined
  ): Record<string, unknown> {
    let nearest: IUnit | null = null;
    let nearestD = Infinity;
    const enemyHeroes: string[] = [];
    this.stateManager.forEachInRadius(hero.position.x, hero.position.y, LOCAL_RADIUS, (u) => {
      if (u.hp <= 0 || u.faction === hero.faction) return;
      const d = Math.hypot(u.position.x - hero.position.x, u.position.y - hero.position.y);
      if (d < nearestD) {
        nearestD = d;
        nearest = u;
      }
    });
    for (const e of this.stateManager.getHeroes()) {
      if (e.faction === hero.faction || e.hp <= 0) continue;
      const d = Math.hypot(e.position.x - hero.position.x, e.position.y - hero.position.y);
      if (d <= HERO_SCAN) {
        enemyHeroes.push(
          `enemy hero ${e.heroIndex}, ${Math.round(d)} tiles ${this.direction(hero, e)}, ${Math.round((100 * e.hp) / e.maxHp)}% HP`
        );
      }
    }
    const prevForce = this.lastForce.get(hero.heroIndex);

    return {
      hp_percent: Math.round((100 * hero.hp) / hero.maxHp),
      status: this.heroStatus(hero),
      place: positionToSubsector(hero.position),
      current_order: hero.command
        ? `${this.describeCommand(hero.command)} (from ${hero.commandSource})`
        : 'none',
      commander_order: hero.lastLlmCommand ? this.describeCommand(hero.lastLlmCommand) : 'none',
      commander_order_age_seconds: hero.lastLlmCommand
        ? Math.round(time - hero.lastLlmTime)
        : 'n/a',
      my_previous_decision: this.lastChoice.get(hero.heroIndex) ?? 'none',
      soldiers_following: group?.followers ?? 0,
      soldiers_avg_hp_percent: group?.avgHpPercent ?? 0,
      soldiers_avg_courage: group?.avgCourage ?? 0,
      soldiers_fleeing: group?.fleeing ?? 0,
      allies_nearby: force.allies,
      enemies_nearby: force.enemies,
      force_ratio: formatRatio(force.ratio),
      force_ratio_4s_ago: prevForce === undefined ? 'n/a' : formatRatio(prevForce),
      nearest_enemy: nearest
        ? `${Math.round(nearestD)} tiles ${this.direction(hero, nearest)}`
        : 'none in sight',
      enemy_heroes_nearby: enemyHeroes.length ? enemyHeroes : 'none',
      stray_soldiers_nearby: this.nearbyStrays(hero).map(
        (s) =>
          `${s.soldiers} stray soldiers, ${s.distance} tiles ${s.direction}, ${s.avgCourage} courage`
      ),
      local_map: this.localMap(hero),
    };
  }

  // A small text map centred on the hero, north at the top. Each character is a 2×2 tile
  // area: H hero, e enemies, a allies, M mountain, f forest, s swamp, . open ground.
  private localMap(hero: IHero): Record<string, unknown> {
    const grid = this.stateManager.getBattlefield().grid;
    const half = Math.floor(LOCAL_RADIUS / MAP_CELL);
    const hx = Math.floor(hero.position.x / MAP_CELL);
    const hy = Math.floor(hero.position.y / MAP_CELL);

    const marks = new Map<number, string>();
    this.stateManager.forEachInRadius(hero.position.x, hero.position.y, LOCAL_RADIUS * 1.5, (u) => {
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
        const mark = marks.get(cy * 1000 + cx);
        if (mark) {
          line += mark;
          continue;
        }
        const t = grid[y][x];
        line +=
          t === TerrainType.MOUNTAIN
            ? 'M'
            : t === TerrainType.FOREST
              ? 'f'
              : t === TerrainType.SWAMP
                ? 's'
                : '.';
      }
      rows.push(line);
    }
    return {
      legend:
        'H this hero, e enemy, a ally, M mountain (impassable), f forest, s swamp, . open, # map edge; north is up, each character is 2x2 tiles',
      rows,
    };
  }

  // D30: objective status in the state, from this side's point of view.
  private objectiveState(): unknown {
    const bf = this.stateManager.getBattlefield();
    const o = bf.objective;
    const mine = this.faction;
    const secondsLeft =
      o.timeLimit === null ? 'n/a' : Math.max(0, Math.round(o.timeLimit - bf.elapsedTime));
    if (o.mode === 'control') {
      return {
        mode: 'control points',
        our_points: Math.round(mine === Faction.FRIENDLY ? o.scores.friendly : o.scores.enemy),
        enemy_points: Math.round(mine === Faction.FRIENDLY ? o.scores.enemy : o.scores.friendly),
        seconds_left: secondsLeft,
        points: o.points.map(
          (p) =>
            `${p.name} at ${exactPlace(p.position)}, held by ${p.holder === null ? 'nobody' : p.holder === mine ? 'us' : 'the enemy'}`
        ),
      };
    }
    if (o.mode === 'base') {
      const base = (f: Faction) => o.bases.find((x) => x.faction === f);
      const pct = (f: Faction) => {
        const b = base(f);
        return b ? Math.round((100 * b.hp) / b.maxHp) : 0;
      };
      const at = (f: Faction) => {
        const b = base(f);
        return b ? exactPlace(b.position) : 'none';
      };
      const enemyF = mine === Faction.FRIENDLY ? Faction.ENEMY : Faction.FRIENDLY;
      return {
        mode: 'destroy the base',
        seconds_left: secondsLeft,
        our_base_at: at(mine),
        our_base_hp_percent: pct(mine),
        enemy_base_at: at(enemyF),
        enemy_base_hp_percent: pct(enemyF),
      };
    }
    return { mode: 'elimination', seconds_left: secondsLeft };
  }

  // Clusters of this side's stray soldiers within reach of the hero, nearest first (D28).
  private nearbyStrays(
    hero: IHero
  ): Array<{ soldiers: number; distance: number; direction: string; avgCourage: number }> {
    return strayClusters(this.stateManager, hero.faction)
      .map((c) => ({
        soldiers: c.soldiers,
        distance: Math.round(
          Math.hypot(c.center.x - hero.position.x, c.center.y - hero.position.y)
        ),
        direction: `to the ${compass(hero.position, c.center)}`,
        avgCourage: c.avgCourage,
      }))
      .filter((s) => s.distance <= STRAY_REACH)
      .sort((a, b) => a.distance - b.distance);
  }

  private heroStatus(hero: IHero): string {
    switch (hero.state) {
      case BehaviorState.ATTACK:
        return 'fighting';
      case BehaviorState.FLEE:
        return 'retreating (survival reflex)';
      case BehaviorState.REST:
        return 'resting to heal';
      default:
        return hero.path.length > 0 ? 'moving' : 'standing';
    }
  }

  private describeCommand(c: HeroCommand): string {
    switch (c.type) {
      case 'move':
        return `move to ${positionToSubsector(c.target)}`;
      case 'hold':
        return `hold position in ${positionToSubsector(c.at)}`;
      case 'retreat':
        return 'retreat to the start position';
      case 'attack':
        return 'attack the nearest enemy';
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

  private direction(from: IUnit, to: IUnit): string {
    return `to the ${compass(from.position, to.position)}`;
  }
}

// Answers come from another service: anything but a finite number counts as no answer, so
// it can neither pass the confidence threshold nor reach the AI panel or the LLM's report.
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
