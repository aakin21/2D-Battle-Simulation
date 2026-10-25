import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { Faction, HeroCommand, IHero, Position } from '../types/types';
import { jevGameRules, JEV_INTERVAL_SEC } from './GameRules';
import { groupStats, GroupStats, localForce } from './Observations';
import type { JevAssessment } from './types';
import { strayClusters, type StrayCluster } from '../engine/Strays';
import { sameCommand } from '../engine/HeroCommands';
import { opponent, sideName } from '../engine/Sides';
import { aiEndpoint, aiHeaders, fetchWithRetries, transientStatus } from './AiServer';
import { AiLayer } from './AiLayer';
import { finishExchange, startExchange } from './Exchange';
import { JEV_MAX_REQUEST_SIZE, JEV_TIMEOUT_MS } from './Limits';
import { TACTICAL_NAME, type TacticalModel } from './Models';
import { SNAP_MAX_QUESTIONS, toSnapRequest } from './Snap';
import { threatCosts } from './Detour';
import { heroQuestions, jevOptions, type JevOption } from './JevQuestions';
import {
  enemyGroupsOf,
  heroGroups,
  heroSituation,
  localMap,
  objectiveState,
  type EnemyGroup,
  type HeroContext,
} from './JevSituation';

// Layer 2 (D6, D21, D26): Jev makes tactical decisions for each hero of one side every few
// seconds. Jev has no memory, so every request carries the relevant rules (game_rules) and
// each hero's surroundings (D16). For each hero Jev picks one option from a list we define,
// and answers three small assessment questions that are logged and reported to the LLM.

export interface JevDecision {
  time: number; // simulation time when the request was sent
  heroIndex: number;
  choice: string;
  confidence: number;
  applied: boolean; // false when confidence was below the threshold, or the answer was stale
  stale?: boolean; // the LLM gave the hero a new order while the request was open: not applied
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

export class JevController extends AiLayer {
  protected opts: JevOptions;
  protected readonly nextAsk = 'decision';
  protected readonly stoppedText = 'tactical layer stopped';
  protected readonly commander = false;
  readonly decisions: JevDecision[] = [];
  private lastForce = new Map<number, number>(); // force ratio per hero at the previous request
  private lastChoice = new Map<number, string>();
  private assessments = new Map<number, Omit<JevAssessment, 'recentDecisions'>>();
  // Where every hero was at the previous request, to tell how enemy heroes move
  private lastPositions: { time: number; at: Map<string, Position> } | undefined;

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

  // Below this confidence a choice is not applied (shown in the AI panel)
  get minConfidence(): number {
    return this.opts.minConfidence;
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

    // Computed once per request, for every hero's options and description
    const groups = groupStats(this.stateManager, this.faction);
    const strays = strayClusters(this.stateManager, this.faction);
    const enemyGroups = enemyGroupsOf(
      this.stateManager,
      this.faction,
      groupStats(this.stateManager, opponent(this.faction))
    );
    const ownGroups = heroGroups(this.stateManager, this.faction);
    // Each hero's local force, taken once: every hero's description counts its allies' too
    const forces = new Map<IHero, { allies: number; enemies: number; ratio: number }>();
    const forceOf = (h: IHero) => {
      let f = forces.get(h);
      if (!f) forces.set(h, (f = localForce(this.stateManager, h)));
      return f;
    };
    let costs: Uint8Array | undefined; // tiles near enemies, only when a hero has a way to check
    const threats = () => (costs ??= threatCosts(this.stateManager, this.faction));
    const options = new Map<number, JevOption[]>();
    const forceNow = new Map<number, number>();
    const questions: Record<string, unknown> = {};
    const state: Record<string, unknown> = {
      game_rules: jevGameRules(
        this.opts.withCommander,
        this.stateManager.getBattlefield().objective.mode
      ),
      objective: objectiveState(this.stateManager, this.faction),
      time_seconds: Math.round(time),
      your_side: sideName(this.faction),
    };

    // The LLM's order each hero's options were built for, to tell a stale answer (applyAnswers)
    const llmOrders = new Map<number, LlmOrderSeen>();
    for (const hero of heroes) {
      const key = `hero${hero.heroIndex}`;
      llmOrders.set(hero.heroIndex, { command: hero.lastLlmCommand, time: hero.lastLlmTime });
      const opts = this.optionsFor(hero, strays, threats);
      options.set(hero.heroIndex, opts);
      const force = forceOf(hero);
      forceNow.set(hero.heroIndex, force.ratio);
      state[key] = this.describeHero(hero, time, force, groups, strays, enemyGroups, {
        ownGroups,
        forceOf,
      });
      Object.assign(questions, heroQuestions(key, hero, opts));
    }
    this.lastPositions = {
      time,
      at: new Map(this.stateManager.getHeroes().map((h) => [h.id, { ...h.position }])),
    };

    // Snap gets the same state, options and questions in its own format (D51)
    const request: Record<string, unknown> =
      this.opts.model === 'snap'
        ? toSnapRequest({ state, questions })
        : { model: 'jev-latest', state, questions };
    const body = JSON.stringify(request);
    const exchange = startExchange(this.exchanges, time, request);
    const questionCount = Object.keys(questions).length;
    if (this.opts.model === 'snap' && questionCount > SNAP_MAX_QUESTIONS) {
      const reason = `Snap takes at most ${SNAP_MAX_QUESTIONS} questions per request (${questionCount} asked)`;
      finishExchange(exchange, 0, null, reason);
      this.fail(reason, '');
      return;
    }
    // Far above a normal request (~20–23 KB with three heroes); the deployed proxy refuses more (api/jev.ts)
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
        fetchWithRetries(
          this.opts.fetchFn,
          this.opts.endpoint,
          { method: 'POST', headers: aiHeaders(), signal, body },
          started + this.opts.timeoutMs
        ),
      (reply, latencyMs, attempts) =>
        this.applyAnswers(reply as JevAnswer | null, time, latencyMs, attempts, {
          heroes,
          options,
          forceNow,
          llmOrders,
        })
    );
  }

  // Uses Jev's answers: keeps each hero's assessment for the LLM's report and applies each
  // choice that is one of the hero's options and confident enough.
  private applyAnswers(
    answer: JevAnswer | null,
    time: number,
    latencyMs: number,
    attempts: number | undefined,
    asked: {
      heroes: IHero[];
      options: Map<number, JevOption[]>;
      forceNow: Map<number, number>;
      llmOrders: Map<number, LlmOrderSeen>;
    }
  ): void {
    const model = typeof answer?.model === 'string' ? answer.model : undefined;
    const inputTokens = num(answer?.usage?.input_tokens);
    const a = answer?.answers ?? {};
    for (const hero of asked.heroes) {
      const key = `hero${hero.heroIndex}`;
      const assessment = {
        surrounded: num(a[`${key}_surrounded`]?.noul),
        threat: num(a[`${key}_threat`]?.score),
        orderStillFits: num(a[`${key}_order_fits`]?.noul),
      };
      this.assessments.set(hero.heroIndex, assessment);
      this.lastForce.set(hero.heroIndex, asked.forceNow.get(hero.heroIndex) ?? Infinity);

      const choice = a[key];
      const option = asked.options.get(hero.heroIndex)?.find((o) => o.key === choice?.choice);
      // The hero may have died, or been taken over by the user, while the request was open
      if (!choice || !option || hero.hp <= 0) continue;
      if (hero.controller !== 'ai' || hero.faction !== this.faction) continue;

      const confidence = num(choice.confidence) ?? 0;
      // A repeated order is ignored by the command interface (D27).
      // An option that does what the commander ordered (e.g. its own regroup while the
      // LLM's order is regroup) is following that order: it runs as "follow the LLM", so the
      // panel, the logs and the override counts show agreement, not an override (CASES 14.6)
      // A retreat stays Jev's own: chosen again at its point it falls back further (D39),
      // which following the LLM's retreat does not do
      const command =
        option.command.type !== 'continueLlm' &&
        option.command.type !== 'retreat' &&
        hero.lastLlmCommand &&
        sameCommand(option.command, hero.lastLlmCommand)
          ? ({ type: 'continueLlm' } as const)
          : option.command;
      // The LLM gave the hero a new order while the request was open: Jev chose for the old one
      // (and continue_around's way leads to its point), so the choice is not applied and the
      // LLM's latest order runs (D15). Following the LLM takes its latest order when it runs, so
      // it still is, also when the choice is the LLM's new order itself. regroup_short collects
      // one stray group, then follows the LLM: still applied while the LLM's new order is of the
      // kind it was chosen for, not when it now says to retreat or hold, or to do something else
      const seen = asked.llmOrders.get(hero.heroIndex);
      const stale =
        llmOrderChanged(hero, seen) &&
        command.type !== 'continueLlm' &&
        !(command.type === 'regroupOne' && sameKindOfOrder(seen?.command ?? null, hero));
      const applied = confidence >= this.opts.minConfidence && !stale;
      if (applied) {
        this.engine.issueCommand(hero, command, 'jev');
        this.lastChoice.set(hero.heroIndex, option.key);
      }
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
        ...(stale ? { stale } : {}),
      });
    }
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

  // The options Jev can choose from for one hero (JevQuestions.ts)
  private optionsFor(
    hero: IHero,
    strays: StrayCluster[] = strayClusters(this.stateManager, hero.faction),
    threats?: () => Uint8Array
  ): JevOption[] {
    return jevOptions(this.stateManager, hero, strays, threats);
  }

  // Everything Jev knows about one hero: its status, orders and surroundings (JevSituation.ts)
  private describeHero(
    hero: IHero,
    time: number,
    force: { allies: number; enemies: number; ratio: number },
    groups: Map<string, GroupStats>,
    strays: StrayCluster[],
    enemyGroups: EnemyGroup[],
    perRequest: Pick<HeroContext, 'ownGroups' | 'forceOf'>
  ): Record<string, unknown> {
    return heroSituation(this.stateManager, hero, {
      time,
      force,
      groups,
      strays,
      enemyGroups,
      ...perRequest,
      previousPositions: this.lastPositions,
      previousForce: this.lastForce.get(hero.heroIndex),
      previousChoice: this.lastChoice.get(hero.heroIndex),
    });
  }

  // The hero's local map alone (the headless tests read it)
  private localMap(hero: IHero): Record<string, unknown> {
    return localMap(this.stateManager, hero);
  }
}

// The LLM's order for a hero when a request was sent
interface LlmOrderSeen {
  command: HeroCommand | null;
  time: number;
}

// The LLM gave the hero a new order since `seen`; restating the same one (the LLM does every
// report, keeping its time, HeroCommands.issue) changes nothing
function llmOrderChanged(hero: IHero, seen: LlmOrderSeen | undefined): boolean {
  if (!seen) return false;
  const now = hero.lastLlmCommand;
  if (now === seen.command) return false;
  if (!now || !seen.command) return true;
  return hero.lastLlmTime !== seen.time || !sameCommand(now, seen.command);
}

// The LLM's order now is of the same kind as the one a regroup_short was chosen for, so the
// regroup still leads on to what it was chosen for; a retreat or hold never is (the group was
// to be collected on the way)
function sameKindOfOrder(seen: HeroCommand | null, hero: IHero): boolean {
  const now = hero.lastLlmCommand;
  return (
    seen !== null &&
    now !== null &&
    now.type === seen.type &&
    now.type !== 'retreat' &&
    now.type !== 'hold'
  );
}

// Jev's (and Snap's) answer, as far as it is used; every value is checked before use
interface JevAnswer {
  model?: unknown;
  usage?: { input_tokens?: unknown };
  answers?: Record<string, { choice?: string; confidence?: number; score?: number; noul?: number }>;
}

// Answers come from another service: anything but a finite number counts as no answer, so
// it can neither pass the confidence threshold nor reach the AI panel or the LLM's report.
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
