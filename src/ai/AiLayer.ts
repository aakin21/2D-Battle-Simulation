import type { AIController, SimulationEngine } from '../engine/SimulationEngine';
import type { StateManager } from '../state/StateManager';
import type { Faction, IHero } from '../types/types';
import {
  deniedByAiServer,
  AI_PASSWORD_HINT,
  unreachableHint,
  failureInfo,
  unreachableStatus,
  FAILURES_IN_A_ROW,
} from './AiServer';
import { AiExchange, finishExchange } from './Exchange';

// What every AI layer is configured with (JevOptions and LlmOptions extend it)
interface AiLayerOptions {
  intervalSec: number; // how often to ask
  fallbackToRules: boolean; // on failure, hand heroes to the rule layer
  endpoint: string;
  fetchFn: typeof fetch;
  timeoutMs: number; // a request without an answer by then counts as a failure
}

// What a request came back with; `attempts` only when it was retried within itself (Jev)
interface Sent {
  res: Response;
  attempts?: number;
}

// The lifecycle both AI layers share (Jev, layer 2; the LLM, layer 3): asking at a fixed
// interval, one request at a time (Q7), a timeout on each request, failures counted or stopping
// the layer, and dispose() dropping a late answer. What is asked and how the answer is used stay
// in the layers.
export abstract class AiLayer implements AIController {
  protected abstract opts: AiLayerOptions;
  protected nextAt = 0;
  protected pending = false;
  protected failed = false;
  readonly exchanges: AiExchange[] = []; // every request with its answer (request log, match log)
  skippedRequests = 0; // a new request was due while the previous one was still open (Q7)
  failedRequests = 0; // requests that failed but were not the last straw
  lastError: string | null = null; // the latest failed request's reason, until an answer comes
  protected failuresInARow = 0;
  failure: string | null = null; // why the layer stopped, for the AI panel and the match log
  protected disposed = false;
  protected inFlight: AbortController | null = null;

  // The layer in console messages ("Jev", "LLM (west)")
  protected abstract get logName(): string;
  // When the layer asks next, in console messages ("decision", "report")
  protected abstract readonly nextAsk: string;
  // What a failure without fallback to the rule layer stops ("tactical layer stopped")
  protected abstract readonly stoppedText: string;

  constructor(
    protected engine: SimulationEngine,
    protected stateManager: StateManager,
    protected faction: Faction
  ) {}

  // Simulation time of the next decision or report (for the AI panel)
  get nextDecisionAt(): number {
    return this.nextAt;
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

  protected abstract decide(time: number): Promise<void>;

  // Whether a refused request (not 2xx) may pass on a later try
  protected abstract retryable(res: Response, info: { retryable: boolean | null }): boolean;

  // What to do about a refused request with this status, or null for the general hints
  protected abstract statusHint(status: number): string | null;

  // The heroes this layer commands: its own side's, alive and AI-controlled
  protected ownHeroes(): IHero[] {
    return this.stateManager
      .getHeroes()
      .filter((h) => h.faction === this.faction && h.hp > 0 && h.controller === 'ai');
  }

  // Sends one request and handles what comes back. The caller has set `pending` and taken
  // `started` (performance.now()) before; this clears `pending` when the request is over.
  // `post` sends the body with the given signal; `delivered` runs when an answer has arrived,
  // before the failure count is reset; `answered` uses the answer.
  protected async request(
    exchange: AiExchange,
    started: number,
    post: (signal: AbortSignal) => Promise<Sent>,
    answered: (body: unknown, latencyMs: number, attempts: number | undefined) => void,
    delivered?: () => void
  ): Promise<void> {
    // An answer that never comes would block the layer, and in paused mode the whole battle
    const abort = new AbortController();
    this.inFlight = abort;
    const timer = setTimeout(() => abort.abort(), this.opts.timeoutMs);
    try {
      const { res, attempts } = await post(abort.signal);
      const latencyMs = performance.now() - started;
      if (this.disposed) return;

      if (!res.ok) {
        const info = await failureInfo(res);
        if (this.disposed) return;
        const reason = `HTTP ${res.status}${info.detail}${attempts !== undefined && attempts > 1 ? ` after ${attempts} tries` : ''}`;
        finishExchange(exchange, latencyMs, null, reason);
        if (attempts !== undefined) exchange.attempts = attempts;
        const retryable = this.retryable(res, info);
        if (retryable && this.tryAgainLater(reason)) return;
        this.fail(
          retryable ? `${reason} (${FAILURES_IN_A_ROW} failed requests in a row)` : reason,
          deniedByAiServer(res)
            ? AI_PASSWORD_HINT
            : (this.statusHint(res.status) ??
                (unreachableStatus(res.status) ? unreachableHint() : ''))
        );
        return;
      }

      const body: unknown = await res.json();
      if (this.disposed) return;
      finishExchange(exchange, latencyMs, body);
      if (attempts !== undefined) exchange.attempts = attempts;
      delivered?.();
      this.failuresInARow = 0;
      this.lastError = null;
      answered(body, latencyMs, attempts);
    } catch (err) {
      if (this.disposed) return;
      const reason = abort.signal.aborted
        ? `no answer within ${this.opts.timeoutMs / 1000} s`
        : String(err);
      if (exchange.latencyMs === null)
        finishExchange(exchange, performance.now() - started, null, reason);
      // A lost connection may come back (a tunnel hiccup; Jev has already retried it twice);
      // no answer within the whole time budget stops the layer, as in paused mode it holds the
      // battle, and the LLM's server gives up and says so first.
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
  // the retries within it (Jev) or behind the endpoint (the LLM's CLI), is counted and the next
  // one goes out as usual; only several failures in a row stop the layer.
  protected tryAgainLater(reason: string): boolean {
    this.failedRequests++;
    this.failuresInARow++;
    this.lastError = reason;
    if (this.failuresInARow >= FAILURES_IN_A_ROW) return false;
    console.warn(
      `${this.logName} request failed (${reason}); asking again at the next ${this.nextAsk}.`
    );
    return true;
  }

  // The layer is unavailable: stop asking. If no other AI layer commands these heroes, hand
  // them back to the rule layer so the game goes on.
  protected fail(reason: string, hint: string): void {
    this.failed = true;
    if (this.opts.fallbackToRules) for (const hero of this.ownHeroes()) hero.controller = 'rule';
    const what = this.opts.fallbackToRules
      ? 'heroes switched to rule-based control'
      : this.stoppedText;
    // The hint says what to do; it is shown in the AI panel and kept in the match log
    this.failure = hint ? `${reason}; ${what}. ${hint}` : `${reason}; ${what}`;
    console.warn(`${this.logName} unavailable (${reason}); ${what}. ${hint}`);
  }
}
