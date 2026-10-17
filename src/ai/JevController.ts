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
import { jevGameRules, JEV_INTERVAL_SEC, JEV_STEP_TILES, RETREAT_ABOUT_TILES } from './GameRules';
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
import { sameCommand } from '../engine/HeroCommands';
import { enemyBase } from '../engine/Objectives';
import { opponent, sideName } from '../engine/Sides';
import { aiEndpoint, aiHeaders, fetchWithRetries, transientStatus } from './AiServer';
import { AiLayer } from './AiLayer';
import { finishExchange, startExchange } from './Exchange';
import { JEV_MAX_REQUEST_SIZE, JEV_TIMEOUT_MS } from './Limits';
import { TACTICAL_NAME, type TacticalModel } from './Models';
import { SNAP_MAX_QUESTIONS, toSnapRequest } from './Snap';

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
  fallbackToRules: boolean; // on failure, hand heroes to the rule layer (the UI passes false: Jev always runs under an LLM, D38)
  withCommander: boolean; // an LLM commands the same side (changes Jev's role and goal)
  model: TacticalModel; // Jev or SubQ Snap (D51): same options, same questions
  endpoint: string;
  fetchFn: typeof fetch;
  timeoutMs: number; // a request without an answer by then counts as a failure
}

const DEFAULTS: JevOptions = {
  intervalSec: JEV_INTERVAL_SEC,
  minConfidence: 0.4,
  fallbackToRules: true,
  withCommander: false,
  model: 'jev',
  endpoint: aiEndpoint('/api/jev'),
  fetchFn: (...args) => fetch(...args),
  timeoutMs: JEV_TIMEOUT_MS,
};

const MAP_CELL = 2; // local map: one character per 2×2 tiles
const STEP_TILES = JEV_STEP_TILES; // length of a "step" move
const HERO_SCAN = LOCAL_RADIUS * 2; // enemy heroes within this distance can be targeted
const STRAY_REACH = 25; // stray groups within this distance are shown to Jev

interface Option {
  key: string;
  what: string;
  notFor: string;
  command: HeroCommand;
}

export class JevController extends AiLayer {
  protected opts: JevOptions;
  protected readonly nextAsk = 'decision';
  protected readonly stoppedText = 'tactical layer stopped';
  readonly decisions: JevDecision[] = [];
  private lastForce = new Map<number, number>(); // force ratio per hero at the previous request
  private lastChoice = new Map<number, string>();
  private assessments = new Map<number, Omit<JevAssessment, 'recentDecisions'>>();

  constructor(
    engine: SimulationEngine,
    stateManager: StateManager,
    faction: Faction,
    opts: Partial<JevOptions> = {}
  ) {
    super(engine, stateManager, faction);
    const model = opts.model ?? DEFAULTS.model;
    this.opts = {
      ...DEFAULTS,
      endpoint: aiEndpoint(model === 'snap' ? '/api/snap' : '/api/jev'),
      ...opts,
      model,
    };
  }

  // The decision model's name for the panels and the match log ("Jev" or "Snap", D51)
  get name(): string {
    return TACTICAL_NAME[this.opts.model];
  }

  get model(): TacticalModel {
    return this.opts.model;
  }

  protected get logName(): string {
    return this.name;
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

  protected async decide(time: number): Promise<void> {
    const heroes = this.ownHeroes();
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
      your_side: sideName(this.faction),
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
          instructions: `Does the commander's order for \`${key}\` (${this.describeCommand(hero.lastLlmCommand)}${hero.lastLlmCommand.reason ? `, given because: ${hero.lastLlmCommand.reason}` : ''}) still make sense in its current situation?`,
        };
      }
    }

    // Snap gets the same state, options and questions in its own format (D51)
    const request: Record<string, unknown> =
      this.opts.model === 'snap'
        ? toSnapRequest({ state, questions })
        : { model: 'jev-latest', state, questions };
    const body = JSON.stringify(request);
    const exchange = startExchange(this.exchanges, time, request);
    if (this.opts.model === 'snap' && Object.keys(questions).length > SNAP_MAX_QUESTIONS) {
      const reason = `Snap takes at most ${SNAP_MAX_QUESTIONS} questions per request (${Object.keys(questions).length} asked)`;
      finishExchange(exchange, 0, null, reason);
      this.fail(reason, '');
      return;
    }
    // Far above a normal request (~13 KB); the deployed proxy refuses more (api/jev.ts)
    if (body.length > JEV_MAX_REQUEST_SIZE) {
      const reason = `request too large (${Math.round(body.length / 1024)} KB)`;
      finishExchange(exchange, 0, null, reason);
      this.fail(reason, '');
      return;
    }

    this.pending = true;
    const started = performance.now();
    await this.request(
      exchange,
      started,
      (signal) =>
        fetchWithRetries(this.opts.fetchFn, this.opts.endpoint, {
          method: 'POST',
          headers: aiHeaders(),
          signal,
          body,
        }),
      (reply, latencyMs, attempts) => {
        const answer = reply as {
          model?: unknown;
          usage?: { input_tokens?: unknown };
          answers?: Record<
            string,
            { choice?: string; confidence?: number; score?: number; noul?: number }
          >;
        } | null;
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
          // An option that does what the commander ordered (e.g. its own regroup while the
          // LLM's order is regroup) is following that order: it runs as "follow the LLM", so the
          // panel, the logs and the override counts show agreement, not an override (CASES 14.6)
          const command =
            option.command.type !== 'continueLlm' &&
            hero.lastLlmCommand &&
            sameCommand(option.command, hero.lastLlmCommand)
              ? ({ type: 'continueLlm' } as const)
              : option.command;
          if (applied) this.engine.issueCommand(hero, command, 'jev');
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
      }
    );
  }

  // 408, 429 and 5xx may pass later; they were already retried within the request
  protected retryable(res: Response): boolean {
    return transientStatus(res);
  }

  protected statusHint(status: number): string | null {
    return status === 401 || status === 403
      ? `Set ${this.opts.model === 'snap' ? 'SUBQ_API_KEY' : 'TYPESAFE_API_KEY'} in .env.local and restart the dev server.`
      : null;
  }

  // The options Jev can choose from for one hero (D20, D26), each with what it is for and
  // what it is not for. Moves are short steps: Jev decides locally, the LLM moves map-wide.
  private optionsFor(hero: IHero): Option[] {
    const here = { x: Math.floor(hero.position.x), y: Math.floor(hero.position.y) };
    const opts: Option[] = [];

    if (hero.lastLlmCommand) {
      opts.push({
        key: 'continue_llm',
        what: `Keep following the commander's order: ${this.describeCommand(hero.lastLlmCommand)}${hero.lastLlmCommand.reason ? ` (its reason: ${hero.lastLlmCommand.reason})` : ''}.`,
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
        what: `Fall back about ${RETREAT_ABOUT_TILES} tiles from the enemies near the hero (what it walks before the next decision; not to the start position) and stay there, to save the hero and its soldiers. Chosen again once the hero has arrived, it falls back further.`,
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
        what: `Collect stray soldiers of our side, one group after another until none is left: it starts with a group of ${goal.soldiers} soldiers, ${d} tiles to the ${compass(hero.position, goal.center)} (a bigger group is preferred to a nearer small one); they follow the hero again and regain its courage bonus.`,
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
      commander_reason: hero.lastLlmCommand ? (hero.lastLlmCommand.reason ?? 'not given') : 'n/a',
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
        const t = cellTerrain(grid, x, y);
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
      const enemyF = opponent(mine);
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
        return 'retreat a short way from the enemies';
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
