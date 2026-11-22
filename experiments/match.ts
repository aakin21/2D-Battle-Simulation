// One match, played in a worker thread of its own (a fresh one per match, as a fresh page would
// be): the real engine (SimulationEngine.step, the fixed 1/60 s step), the real AI layers
// (LlmController, JevController) attached as UIController.startControllers attaches them, their
// requests sent over HTTP to the AI server exactly as the browser sends them, and the match log
// of src/ui/MatchLog.ts. A worker has its own Math.random, so matches played at once never draw
// from each other's generator.
//
// What the browser does that a worker has no use for: drawing (the renderers are stubs; drawing
// never changes the simulation, tests/smoke/render.ts) and requestAnimationFrame, given here as a
// 60 Hz display would give it (Vsync) when the match is paced to the wall clock.
import './node';
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { StateManager } from '../src/state/StateManager';
import { SimulationEngine, type AIController } from '../src/engine/SimulationEngine';
import { LlmController } from '../src/ai/LlmController';
import { JevController } from '../src/ai/JevController';
import { AiLayer } from '../src/ai/AiLayer';
import { TACTICAL_NAME, type LlmModel } from '../src/ai/Models';
import { MatchLog, type AiSides } from '../src/ui/MatchLog';
import { decodeGrid } from '../src/state/MapStore';
import { SIM_STEP, STEPS_PER_SECOND } from '../src/engine/Rules';
import { BATTLE_CONFIG, Faction, type SideAI, type SimConfig } from '../src/types/types';
import type { Renderer } from '../src/rendering/Renderer';
import type { MinimapRenderer } from '../src/rendering/MinimapRenderer';
import { tacticalOf, usesAi, type MatchDef, type SideSpec } from './plan';
import { outcomeHash } from './results';

// What the main thread gives a worker
export interface MatchJob {
  def: MatchDef;
  aiServer: string | null; // origin of /api/llm, /api/jev, /api/snap
  plan: { name: string; hash: string; file: string };
  code: { version: string; commit: string; dirty: boolean; bundle: string };
  aiServerStatus: unknown; // GET /api/bridge's answer at the start of the run, or null
}

// What a worker tells the main thread
export type FromWorker =
  | { type: 'spend'; usd: number } // reported cost of answers since the last message
  | { type: 'progress'; t: number } // simulation seconds
  | { type: 'done'; log: string; usd: number } // the match log (JSON text) and the last spend
  | { type: 'failed'; message: string }; // the runner itself failed (not the simulation)

// One request of an AI layer, as the runner saw it: when it was sent and when its answer arrived
// in simulation time, for what an answer's latency cost in the battle (real-time timing)
interface RequestSeen {
  layer: string; // "west.llm", "east.tactical"
  seq: number | null; // the exchange's seq in the match log
  sentAt: number; // simulation seconds
  arrivedAt: number | null; // simulation seconds when the (last try's) answer arrived
  wallMs: number | null; // first try sent → last answer arrived
  // Real-time timing: the frame in which the request was made → its answer, in wall time. A frame's
  // steps stand for the time up to its vsync, and the request leaves after the step has built it,
  // so this, not wallMs, is the wall time the battle's clock went on for while waiting
  sinceFrameMs: number | null;
  tries: number;
  held: boolean; // paused timing: applied after its side's tactical answer of the same step
}

const FRAME_MS = 1000 / 60;
// Real-time pacing has fallen behind when the battle lags the wall clock by more than this
const BEHIND_SECONDS = 3 * SIM_STEP;

// The smoke tests' generator (tests/smoke/same.ts): the simulation's Math.random, from the seed
function seedRandom(seed: number): void {
  let s = seed;
  Math.random = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The renderers: a worker draws nothing (getCamera is read by the frame's minimap call)
const drawNothing = new Proxy(
  {},
  { get: (_t, k) => (k === 'getCamera' ? () => ({ x: 0, y: 0, zoom: 5 }) : () => undefined) }
);

// requestAnimationFrame as a 60 Hz display gives it: a frame at each vsync (every 1000/60 ms
// from the first), its timestamp the vsync's time; a frame that comes late is the latest vsync
// passed, so the vsyncs in between are skipped, as a browser skips them. The engine's own loop
// (frame → advance) turns these timestamps into steps, so a slow machine loses game time exactly
// as the browser does (at most 0.1 s per frame, MAX_FRAME_SECONDS).
class Vsync {
  private active = false;
  private origin = 0;
  private last = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  frames = 0;
  skipped = 0; // vsyncs passed without a frame
  maxGapMs = 0; // longest real time between two frames
  firstAt: number | null = null; // the first frame's timestamp (ms)
  lastAt = 0;

  start(): void {
    this.active = true;
    this.origin = performance.now();
    this.last = -1;
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  request(cb: FrameRequestCallback): number {
    if (!this.active) return 0;
    const now = performance.now();
    const k = Math.max(this.last + 1, Math.ceil((now - this.origin) / FRAME_MS));
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (!this.active) return;
        const at = performance.now();
        const kk = Math.max(k, Math.floor((at - this.origin) / FRAME_MS));
        if (this.last >= 0) {
          this.skipped += kk - this.last - 1;
          this.maxGapMs = Math.max(this.maxGapMs, (kk - this.last) * FRAME_MS);
        }
        this.last = kk;
        this.frames++;
        const ts = this.origin + kk * FRAME_MS;
        this.firstAt ??= ts;
        this.lastAt = ts;
        cb(ts);
      },
      Math.max(0, this.origin + k * FRAME_MS - now)
    );
    return 1;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextTurn = () => new Promise<void>((r) => setImmediate(r));

async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await sleep(1);
}

// A layer's request may go to the AI server's origin only (refused and counted otherwise)
export function toAiServer(url: string, aiServer: string | null): boolean {
  try {
    return aiServer !== null && new URL(url).origin === aiServer;
  } catch {
    return false;
  }
}

function sideAi(side: SideSpec): SideAI {
  return side.commander === 'rules' ? 'none' : side.commander === 'llm' ? 'llm' : 'jev+llm';
}

// The browser's battlefield hash of tests/smoke/same.ts: the same match gives the same hash
export function stateHash(sm: StateManager, result: unknown): string {
  const bf = sm.getBattlefield();
  const state = JSON.stringify(
    {
      units: bf.units,
      objective: bf.objective,
      stats: bf.stats,
      wave: bf.waveNumber,
      t: bf.elapsedTime,
      result,
    },
    (k, v) => (k === 'viaReached' && v === null ? undefined : v)
  );
  return createHash('sha256').update(state).digest('hex').slice(0, 16);
}

export async function playMatch(
  job: MatchJob,
  post: (m: FromWorker) => void
): Promise<{ log: Record<string, unknown>; usd: number }> {
  const d = job.def;
  const startedAt = new Date().toISOString();
  const wallStart = performance.now();
  seedRandom(d.seed);
  (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = job.code.version;
  const vsync = new Vsync();
  globalThis.requestAnimationFrame = (cb) => vsync.request(cb);
  globalThis.cancelAnimationFrame = () => vsync.stop();
  // The layers' console messages, with the match they belong to
  for (const level of ['warn', 'error'] as const) {
    const write = console[level].bind(console);
    console[level] = (...args: unknown[]) => write(`[${d.key}]`, ...args);
  }

  const model = (side: SideSpec) => (usesAi(side) ? (side.model as LlmModel) : undefined);
  const config: SimConfig = {
    ...BATTLE_CONFIG,
    warriorCount: d.soldiers,
    terrainDensity: d.terrain,
    objective: d.objective,
    presetGrid: d.mapGrid ? (decodeGrid(d.mapGrid) ?? undefined) : undefined,
    friendlyAI: sideAi(d.west),
    enemyAI: sideAi(d.east),
    aiTiming: d.timing,
    recordReplay: false,
    friendlyModel: model(d.west),
    enemyModel: model(d.east),
    friendlyTactical: tacticalOf(d.west) ?? 'jev',
    enemyTactical: tacticalOf(d.east) ?? 'jev',
  };
  if (d.mapGrid && !config.presetGrid) throw new Error('the map cannot be read');

  const sm = new StateManager();
  const engine = new SimulationEngine(
    sm,
    drawNothing as unknown as Renderer,
    drawNothing as unknown as MinimapRenderer
  );
  engine.applyConfig(config);
  engine.restart();
  const bf = () => sm.getBattlefield();

  // The browser offers Rules only for East (West's "none" is the user). A West commanded by the
  // rules gets its heroes given to the rule layer before the first step, as a stopped AI layer
  // gives them (AiLayer.fail) and as the title screen's recorded battle was made
  // (tests/smoke/attract-record.ts)
  if (d.west.commander === 'rules')
    for (const hero of sm.getHeroes())
      if (hero.faction === Faction.FRIENDLY) hero.controller = 'rule';

  // --- The AI layers, as UIController.startControllers attaches them ---
  const aiSides: AiSides = { west: {}, east: {} };
  const seen: RequestSeen[] = [];
  const firstTry = new Map<RequestSeen, number>();
  const frameOf = new Map<RequestSeen, number>(); // the vsync time of the frame that sent it
  let refused = 0;
  let held = 0;
  const paused = d.timing === 'paused';
  // A layer's requests: only to the AI server; in paused timing an LLM answer that arrives while
  // its side's tactical layer still waits for its answer of the same step is applied after it
  // (the order the layers asked in), so the match does not depend on which answer came first
  const layerFetch = (
    name: string,
    layer: () => AiLayer | undefined,
    holdFor: () => AiLayer | undefined
  ): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!toAiServer(url, job.aiServer)) {
        refused++;
        throw new TypeError('refused: the runner sends requests to the AI server only');
      }
      // Jev's tries of one request share its exchange (fetchWithRetries)
      const seq = layer()?.exchanges.at(-1)?.seq ?? null;
      let record = seen.find((r) => r.layer === name && r.seq === seq && seq !== null);
      if (!record) {
        record = {
          layer: name,
          seq,
          sentAt: bf().elapsedTime,
          arrivedAt: null,
          wallMs: null,
          sinceFrameMs: null,
          tries: 0,
          held: false,
        };
        seen.push(record);
        firstTry.set(record, performance.now());
        if (vsync.firstAt !== null) frameOf.set(record, vsync.lastAt);
      }
      record.tries++;
      const res = await fetch(url, init);
      record.arrivedAt = bf().elapsedTime;
      const now = performance.now();
      record.wallMs = Math.round((now - firstTry.get(record)!) * 10) / 10;
      const frame = frameOf.get(record);
      if (frame !== undefined) record.sinceFrameMs = Math.round((now - frame) * 10) / 10;
      const tactical = holdFor();
      if (!paused || !tactical || !tactical.isWaiting()) return res;
      record.held = true;
      held++;
      const later =
        <T>(read: () => Promise<T>) =>
        async (): Promise<T> => {
          await until(() => !tactical.isWaiting());
          return read();
        };
      return new Proxy(res, {
        get(target, prop) {
          if (prop === 'json') return later(() => target.json());
          if (prop === 'text') return later(() => target.text());
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }) as typeof fetch;

  const controllers: AIController[] = [];
  for (const [faction, name, side] of [
    [Faction.FRIENDLY, 'west', d.west],
    [Faction.ENEMY, 'east', d.east],
  ] as const) {
    if (!usesAi(side)) continue;
    const tactical = tacticalOf(side);
    const ai = aiSides[name];
    if (tactical) {
      ai.jev = new JevController(engine, sm, faction, {
        fallbackToRules: false,
        withCommander: true,
        model: tactical,
        endpoint: `${job.aiServer}${tactical === 'snap' ? '/api/snap' : '/api/jev'}`,
        fetchFn: layerFetch(
          `${name}.tactical`,
          () => ai.jev,
          () => undefined
        ),
      });
      controllers.push(ai.jev);
    }
    ai.llm = new LlmController(engine, sm, faction, {
      model: side.model as LlmModel,
      fallbackToRules: !tactical,
      jevAssessment: ai.jev ? (heroIndex) => ai.jev!.assessmentFor(heroIndex) : null,
      tacticalName: TACTICAL_NAME[tactical ?? 'jev'],
      endpoint: `${job.aiServer}/api/llm`,
      fetchFn: layerFetch(
        `${name}.llm`,
        () => ai.llm,
        () => ai.jev
      ),
    });
    controllers.push(ai.llm);
  }
  engine.setControllers(controllers);
  const log = new MatchLog(config, d.map, aiSides);
  log.sample(sm);

  // --- Each step: the log's timeline, the spend, progress, the plan's stop ---
  let steps = 0;
  let stopped = false; // the plan's stopAtSeconds
  let costSeen = 0;
  const decisionsSeen = { west: 0, east: 0 };
  // The answers' reported cost since the last call
  const takeSpend = (): number => {
    let usd = 0;
    for (const name of ['west', 'east'] as const) {
      const decisions = aiSides[name].llm?.decisions ?? [];
      for (let i = decisionsSeen[name]; i < decisions.length; i++)
        usd += decisions[i].usage?.costUsd ?? 0;
      decisionsSeen[name] = decisions.length;
    }
    costSeen += usd;
    return usd;
  };
  const reportSpend = () => {
    const usd = takeSpend();
    if (usd > 0) post({ type: 'spend', usd });
  };
  let nextProgress = 10;
  let finish = () => {}; // real-time timing: ends the paced loop
  engine.setOnStep(() => {
    steps++;
    log.sample(sm);
    reportSpend();
    const t = bf().elapsedTime;
    if (t >= nextProgress) {
      post({ type: 'progress', t });
      nextProgress = Math.floor(t / 10) * 10 + 10;
    }
    if (d.stopAtSeconds !== null && t >= d.stopAtSeconds - 1e-9 && !engine.getResult()) {
      stopped = true;
      engine.pause();
      finish();
    }
  });

  const ai = controllers.length > 0;
  let error: string | null = null;
  let pacing: Record<string, unknown>;
  if (ai && d.timing === 'realtime') {
    // The engine's own fixed-step loop on a 60 Hz display (D65): what an answer's latency costs
    // in the battle is what it costs in the browser at 1x
    await new Promise<void>((resolve) => {
      finish = () => {
        vsync.stop();
        engine.stop();
        resolve();
      };
      engine.setOnMatchEnd(() => finish());
      engine.setOnError(() => finish());
      vsync.start();
      engine.start();
    });
    error = engine.getError();
    const wall = vsync.firstAt === null ? 0 : (vsync.lastAt - vsync.firstAt) / 1000;
    const lag = wall - steps / STEPS_PER_SECOND;
    pacing = {
      mode: 'real time: the engine loop on a 60 Hz display',
      frames: vsync.frames,
      skippedFrames: vsync.skipped,
      maxFrameGapMs: Math.round(vsync.maxGapMs * 10) / 10,
      wallSeconds: Math.round(wall * 1000) / 1000,
      gameSeconds: Math.round((steps / STEPS_PER_SECOND) * 1000) / 1000,
      lagSeconds: Math.round(lag * 1000) / 1000,
      fellBehind: lag > BEHIND_SECONDS,
    };
  } else {
    // Paused timing waits for every answer (D4), as fast as they come; a match without AI layers
    // has nothing to wait for and runs as fast as the machine goes (D65: the same battle at any
    // speed)
    let waits = 0;
    let waitedMs = 0;
    let turn = performance.now();
    while (!engine.getResult() && !stopped) {
      if (engine.isWaitingForAI()) {
        const since = performance.now();
        waits++;
        await until(() => !engine.isWaitingForAI());
        waitedMs += performance.now() - since;
        turn = performance.now();
        continue;
      }
      try {
        engine.step();
      } catch (err) {
        // As the engine's loop stops a run (SimulationEngine.fail)
        error = err instanceof Error ? err.message : String(err);
        console.error('Simulation stopped:', err);
        break;
      }
      if (performance.now() - turn > 50) {
        await nextTurn();
        turn = performance.now();
      }
    }
    pacing = ai
      ? {
          mode: 'paused: the battle waits for every answer',
          waits,
          waitedSeconds: Math.round(waitedMs) / 1000,
        }
      : { mode: 'no AI layer: as fast as the machine goes' };
  }
  // Sent with the match log, so a match whose last answers reach the cap is kept, not abandoned
  const lastSpend = takeSpend();

  const result = engine.getResult();
  const built = log.build(sm, result, error);
  const finalStateHash = stateHash(sm, result);
  engine.setControllers([]); // stops asking; an answer still on its way is dropped
  const experiment = {
    runner: 'experiments/run.ts',
    plan: job.plan,
    match: {
      key: d.key,
      hash: d.hash,
      index: d.index,
      condition: d.condition,
      subjectSide: d.subjectSide,
      objective: d.objective,
      map: d.map,
      mapHash: d.mapHash,
      seed: d.seed,
      timing: d.timing,
      soldiers: d.soldiers,
      terrain: d.terrain,
      stopAtSeconds: d.stopAtSeconds,
    },
    // The settings' west "none" with rules is the rule layer here (see above)
    sides: { west: d.west, east: d.east },
    code: job.code,
    node: process.version,
    aiServer: job.aiServer ? { address: job.aiServer, status: job.aiServerStatus } : null,
    startedAt,
    wallSeconds: Math.round(performance.now() - wallStart) / 1000,
    steps,
    stoppedAt: stopped ? bf().elapsedTime : null,
    pacing,
    answersHeld: held,
    requests: seen,
    refusedRequests: refused,
    reportedCostUsd: Math.round(costSeen * 1e6) / 1e6,
    finalStateHash,
    outcomeHash: '',
  };
  const out: Record<string, unknown> = { ...built, experiment };
  experiment.outcomeHash = outcomeHash(out);
  return { log: out, usd: lastSpend };
}

// --- The worker ---
if (parentPort && workerData && (workerData as { job?: unknown }).job) {
  const port = parentPort;
  const post = (m: FromWorker) => port.postMessage(m);
  playMatch((workerData as { job: MatchJob }).job, post).then(
    ({ log, usd }) => post({ type: 'done', log: JSON.stringify(log, null, 2), usd }),
    (err: unknown) =>
      post({
        type: 'failed',
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
  );
}
