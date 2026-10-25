import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { Faction, IHero, BehaviorState, LlmModel } from '../types/types';
import { llmSystemPrompt } from './GameRules';
import { LLM_TIMEOUT_MS } from './Limits';
import { hpPercent } from './Observations';
import { sideName } from '../engine/Sides';
import { aiEndpoint, aiHeaders, deniedByAiServer, transientStatus } from './AiServer';
import { AiLayer } from './AiLayer';
import { startExchange } from './Exchange';
import { describeCommand } from './Describe';
import { buildReport, type ReportMemory } from './LlmReport';
import { readOrder, readReply, usageOf } from './LlmReply';
import type { JevAssessment, LlmDecision, LlmUsage } from './types';

// Layer 3 (D1, D10): the LLM plans the overall strategy every 15 s (D50) from a computed summary
// of the whole map (D16, R5). It runs in the dev server through the Claude Agent SDK.

export type { JevAssessment, LlmDecision, LlmUsage } from './types';

export interface LlmOptions {
  intervalSec: number;
  fallbackToRules: boolean; // on failure, hand heroes to the rule layer (when the LLM is the only AI layer)
  endpoint: string;
  fetchFn: typeof fetch;
  jevAssessment: ((heroIndex: number) => JevAssessment) | null; // set when Jev runs on the same side
  model: LlmModel;
  tacticalName: string; // the tactical layer's name in the rulebook ("Jev" or "Snap", D51)
  timeoutMs: number; // a request without an answer by then counts as a failure
}

const DEFAULTS: LlmOptions = {
  intervalSec: 15, // D50: answers take ~4–10 s (Sonnet, Opus)
  fallbackToRules: true,
  endpoint: aiEndpoint('/api/llm'),
  fetchFn: (...args) => fetch(...args),
  jevAssessment: null,
  model: 'sonnet',
  tacticalName: 'Jev',
  timeoutMs: LLM_TIMEOUT_MS,
};

export class LlmController extends AiLayer {
  protected opts: LlmOptions;
  protected readonly nextAsk = 'report';
  protected readonly stoppedText = 'strategic layer stopped';
  protected readonly commander = true;
  // Not from Math.random: the simulation draws from it, and creating a controller must not
  // change the battle
  private readonly matchId = `match_${Date.now()}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  private readonly side: 'west' | 'east';
  readonly system: string; // the rulebook sent as the session's system prompt
  readonly decisions: LlmDecision[] = [];

  // Memory between reports: what the last report the LLM saw counted, and the hero events
  // noted since
  private counted: ReportMemory = { forceRatio: null, soldiers: null, followers: new Map() };
  private events: string[] = [];
  private heroAlive = new Map<string, IHero>();
  private heroFleeing = new Set<string>();

  constructor(
    engine: SimulationEngine,
    stateManager: StateManager,
    faction: Faction,
    opts: Partial<LlmOptions> = {}
  ) {
    super(engine, stateManager, faction);
    this.opts = { ...DEFAULTS, ...opts };
    this.side = sideName(faction);
    this.system = llmSystemPrompt(
      this.side,
      this.opts.jevAssessment !== null,
      this.opts.intervalSec,
      stateManager.getBattlefield().objective.mode,
      this.opts.tacticalName
    );
  }

  protected get logName(): string {
    return `LLM (${this.side})`;
  }

  // Hero events are noted every step, before the base class decides whether to ask; a layer
  // that stopped sends no more reports, so it notes none
  tick(elapsed: number): void {
    if (this.failed || this.disposed) return;
    this.watchEvents(elapsed);
    super.tick(elapsed);
  }

  // Notes hero deaths and survival-reflex retreats as they happen, for the next report.
  // Runs every step: the list of heroes is only copied when it has changed.
  private watchEvents(elapsed: number): void {
    const t = Math.round(elapsed);
    const heroes = this.stateManager.getHeroes();
    if (!this.sameHeroes(heroes)) {
      const current = new Map(heroes.map((h) => [h.id, h]));
      for (const [id, h] of this.heroAlive) {
        if (!current.has(id))
          this.events.push(`t=${t}s ${this.owner(h)} hero ${h.heroIndex} was killed`);
      }
      this.heroAlive = current;
    }
    for (const h of this.heroAlive.values()) {
      const fleeing = h.state === BehaviorState.FLEE;
      if (fleeing && !this.heroFleeing.has(h.id)) {
        this.events.push(
          `t=${t}s ${this.owner(h)} hero ${h.heroIndex} started retreating (survival reflex, ${hpPercent(h)}% HP)`
        );
        this.heroFleeing.add(h.id);
      } else if (!fleeing) this.heroFleeing.delete(h.id);
    }
  }

  // The heroes are the ones seen at the last step, in the same order (none has died or come)
  private sameHeroes(heroes: IHero[]): boolean {
    if (heroes.length !== this.heroAlive.size) return false;
    let i = 0;
    for (const h of this.heroAlive.values()) if (heroes[i++] !== h) return false;
    return true;
  }

  private owner(h: IHero): string {
    return h.faction === this.faction ? 'your' : 'enemy';
  }

  // The heroes this layer commands (AiLayer.ownHeroes)
  private myHeroes(): IHero[] {
    return this.ownHeroes();
  }

  protected async decide(time: number): Promise<void> {
    const heroes = this.myHeroes();
    if (heroes.length === 0) return;

    const started = performance.now();
    const { report, remember } = this.report(time);
    // The rulebook is the same in every request; the log keeps it once, in `system`
    const exchange = startExchange(this.exchanges, time, {
      side: this.side,
      matchId: this.matchId,
      model: this.opts.model,
      prompt: report,
    });
    // Set once the report is built: a throw before (AiLayer.tick) leaves no request waiting
    this.pending = true;
    await this.request(
      exchange,
      started,
      async (signal) => ({
        res: await this.opts.fetchFn(this.opts.endpoint, {
          method: 'POST',
          headers: aiHeaders(),
          signal,
          body: JSON.stringify({
            side: this.side,
            matchId: this.matchId,
            system: this.system,
            model: this.opts.model,
            prompt: JSON.stringify(report),
          }),
        }),
      }),
      (answer, latencyMs) => {
        const body = answer as Record<string, unknown> | null;
        // A reply that is not text is applied as an empty one: "not valid JSON", layer goes on
        const text = typeof body?.text === 'string' ? body.text : '';
        const model = typeof body?.model === 'string' ? body.model : this.opts.model;
        this.apply(time, latencyMs, text, model, usageOf(body));
      },
      // The report reached the LLM: the next one counts its changes from this one
      remember
    );
  }

  // The endpoint says whether trying again may help; a refused AI password never does. The
  // CLI behind the endpoint has already retried, so there are no retries here.
  protected retryable(res: Response, info: { retryable: boolean | null }): boolean {
    return !deniedByAiServer(res) && (info.retryable ?? transientStatus(res));
  }

  protected statusHint(status: number): string | null {
    return status === 404 || status === 405
      ? 'This site has no LLM endpoint: run npm run dev, or open the demo through the tunnel (?ai=...).'
      : null;
  }

  // Validates the LLM's reply and applies the usable orders through the command interface.
  private apply(
    time: number,
    latencyMs: number,
    text: string,
    model: string,
    usage: LlmUsage | null
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

    const orders = readReply(text, d);
    if (!orders) return;
    for (const entry of orders) {
      const order = readOrder(this.stateManager, this.myHeroes(), entry);
      if (typeof order === 'string') {
        d.rejected.push(order);
        continue;
      }
      const { hero, command, reason } = order;
      // Always issued, even if unchanged: the LLM's latest order wins when it arrives (D15).
      this.engine.issueCommand(hero, command, 'llm');
      d.orders.push(
        `hero ${hero.heroIndex}: ${describeCommand(command, 'llm')}${reason ? ` (${reason})` : ''}`
      );
    }
  }

  // The whole battlefield as computed values (LlmReport.ts). What the next report compares
  // with is kept only once this report has reached the LLM (remember() is called when its
  // answer arrives): after a failed request the next report still carries these events and
  // counts its changes from the last report the LLM saw.
  private report(time: number): { report: Record<string, unknown>; remember: () => void } {
    const { report, counted } = buildReport(this.stateManager, this.faction, {
      time,
      previous: this.decisions[this.decisions.length - 1],
      memory: this.counted,
      events: this.events,
      jevAssessment: this.opts.jevAssessment,
    });
    const sentEvents = this.events.length;
    const remember = () => {
      this.counted = counted;
      this.events.splice(0, sentEvents); // events noted while waiting stay for the next one
    };
    return { report, remember };
  }
}
