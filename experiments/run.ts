// The experiment runner: plays a plan's matches without a browser and writes their match logs and
// a summary table. Usage (see experiments/README.md):
//   npm run experiment -- <plan.json> [--dry-run] [--ai-server <address>] [--out <folder>]
//                                     [--parallel <n>]
// Each match runs in a worker thread of its own (experiments/match.ts). A finished match is
// written as one file, whole or not at all; a run started again skips the finished ones.
import './node';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import { readRuns, statusBody } from '../src/ai/BridgeConnect';
import { cliToolOf, codexModel, geminiModelId, localModelId, openRouterId } from '../src/ai/Models';
import { LLM_INTERVAL_SEC } from '../src/ai/LlmController';
import { JEV_INTERVAL_SEC } from '../src/ai/GameRules';
import { CONTROL_TIME_LIMIT, MATCH_TIME_LIMIT } from '../src/engine/Rules';
import {
  PlanError,
  readPlan,
  REPO_ROOT,
  seedList,
  sha256,
  sideText,
  tacticalOf,
  usesAi,
  type ExpandedPlan,
  type MatchDef,
} from './plan';
import {
  ensureDir,
  MATCHES_DIR,
  matchFileName,
  matchRow,
  MEASURED_COLUMNS,
  readMatchFiles,
  removeLeftovers,
  ROLES,
  toCsv,
  writeAtomic,
  type Json,
  type Row,
} from './results';
import type { FromWorker, MatchJob } from './match';

class RunError extends Error {}

const WORKER = new URL('./match.mjs', import.meta.url);
const STATUS_TIMEOUT_MS = 5_000;
const STATUS_EVERY_MS = 30_000;

// --- Arguments ---

interface Args {
  plan: string;
  dryRun: boolean;
  aiServer?: string;
  out?: string;
  parallel?: number;
  maxMatches?: number;
}

const USAGE = `Usage: npm run experiment -- <plan.json> [options]
  --dry-run              print what would be played, with estimates; play nothing
  --ai-server <address>  the AI server (overrides the plan's aiServer), e.g. http://127.0.0.1:5173
  --out <folder>         the results folder (overrides the plan's out)
  --parallel <n>         matches at once (overrides the plan's parallel)
  --max-matches <n>      only the plan's first n matches (overrides the plan's maxMatches)
Ctrl+C once: no new matches, the running ones finish; twice: they are abandoned (no files).`;

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new RunError(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--ai-server') args.aiServer = value();
    else if (a === '--out') args.out = value();
    else if (a === '--parallel') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 64)
        throw new RunError('--parallel: a whole number from 1 to 64');
      args.parallel = n;
    } else if (a === '--max-matches') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1)
        throw new RunError('--max-matches: a whole number of 1 or more');
      args.maxMatches = n;
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('--')) throw new RunError(`unknown option ${a}\n${USAGE}`);
    else if (args.plan === undefined) args.plan = a;
    else throw new RunError(`one plan at a time\n${USAGE}`);
  }
  if (!args.plan) throw new RunError(`a plan file is needed\n${USAGE}`);
  return args as Args;
}

// --- Code version (as vite.config.ts writes it into the browser's match log) ---

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function codeVersion(): MatchJob['code'] {
  let bundle = 'unknown';
  try {
    bundle = sha256(readFileSync(fileURLToPath(WORKER), 'utf8')).slice(0, 16);
  } catch {
    // not bundled
  }
  return {
    version: git(['describe', '--tags', '--always', '--dirty']) ?? 'unknown',
    commit: git(['rev-parse', 'HEAD']) ?? 'unknown',
    dirty: (git(['status', '--porcelain', '--untracked-files=no']) ?? '') !== '',
    bundle,
  };
}

// --- Estimates (--dry-run) ---

// Defaults, each an estimate: answer times from D50 (Sonnet 3.3–3.9 s mean through the Agent
// SDK) and R14 (Jev's median 545 ms); the engine's cost per step from CASES 34.20 (this Mac,
// 0.27 ms a step at 150 per side, 3.0 ms at 1000 per side)
const DEFAULT_LLM_ANSWER_S = 4;
const DEFAULT_TACTICAL_ANSWER_S = 0.55;

function msPerStep(soldiers: number): number {
  return soldiers <= 150
    ? Math.max(0.05, (0.27 * soldiers) / 150)
    : 0.27 + ((soldiers - 150) * (3.0 - 0.27)) / 850;
}

interface Estimate {
  gameSeconds: number;
  llmRequests: number;
  tacticalRequests: number;
  wallSeconds: number;
  usd: number | null;
}

function estimate(d: MatchDef, plan: ExpandedPlan['plan']): Estimate {
  const game =
    d.stopAtSeconds ?? (d.objective === 'control' ? CONTROL_TIME_LIMIT : MATCH_TIME_LIMIT);
  const sides = [d.west, d.east];
  const llmSides = sides.filter(usesAi).length;
  const tacticalSides = sides.filter((s) => tacticalOf(s) !== null).length;
  const llmAsks = Math.ceil(game / LLM_INTERVAL_SEC);
  const tacticalAsks = Math.ceil(game / JEV_INTERVAL_SEC);
  const e = plan.estimates ?? {};
  const compute = (game * 60 * msPerStep(d.soldiers)) / 1000;
  let wall = compute;
  if (llmSides && d.timing === 'realtime') wall = game;
  else if (llmSides)
    // Paused: both sides' LLMs ask at the same steps, so their waits overlap
    wall +=
      llmAsks * (e.llmAnswerSeconds ?? DEFAULT_LLM_ANSWER_S) +
      (tacticalSides ? tacticalAsks * (e.tacticalAnswerSeconds ?? DEFAULT_TACTICAL_ANSWER_S) : 0);
  const usd =
    e.llmRequestUsd === undefined && e.tacticalRequestUsd === undefined
      ? null
      : llmSides * llmAsks * (e.llmRequestUsd ?? 0) +
        tacticalSides * tacticalAsks * (e.tacticalRequestUsd ?? 0);
  return {
    gameSeconds: game,
    llmRequests: llmSides * llmAsks,
    tacticalRequests: tacticalSides * tacticalAsks,
    wallSeconds: wall,
    usd,
  };
}

export function duration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}

const usd = (v: number) => `$${v < 10 ? v.toFixed(3) : v.toFixed(2)}`;

// --- The results folder ---

interface Folder {
  finished: Map<string, Json>; // "key.hash" → match log
  notInPlan: string[];
  unreadable: string[];
  spentFinished: number; // reported costs of every finished match in the folder
  spentAbandoned: number; // of matches abandoned or failed before (abandoned.jsonl)
}

function readFolder(x: ExpandedPlan): Folder {
  const { files, unreadable } = readMatchFiles(x.out);
  const wanted = new Set(x.matches.map((m) => `${m.key}.${m.hash}`));
  const finished = new Map<string, Json>();
  const notInPlan: string[] = [];
  let spentFinished = 0;
  for (const f of files) {
    spentFinished += Number((f.log.experiment as Json).reportedCostUsd) || 0;
    if (wanted.has(`${f.key}.${f.hash}`)) finished.set(`${f.key}.${f.hash}`, f.log);
    else notInPlan.push(f.file);
  }
  let spentAbandoned = 0;
  const ledger = join(x.out, 'abandoned.jsonl');
  if (existsSync(ledger))
    for (const line of readFileSync(ledger, 'utf8').split('\n'))
      if (line.trim())
        try {
          spentAbandoned += Number((JSON.parse(line) as Json).reportedCostUsd) || 0;
        } catch {
          // a line cut by a kill: ignored
        }
  return { finished, notInPlan, unreadable, spentFinished, spentAbandoned };
}

function writeSummary(x: ExpandedPlan): { rows: Row[] } {
  const { files } = readMatchFiles(x.out);
  const byId = new Map(files.map((f) => [`${f.key}.${f.hash}`, f.log]));
  const rows: Row[] = [];
  for (const m of x.matches) {
    const log = byId.get(`${m.key}.${m.hash}`);
    if (log) rows.push(matchRow(log));
  }
  writeAtomic(join(x.out, 'summary.csv'), toCsv(rows));
  writeAtomic(
    join(x.out, 'summary.json'),
    JSON.stringify(
      {
        plan: x.plan.name,
        planHash: x.hash,
        columns: rows.length ? Object.keys(rows[0]) : [],
        measuredColumns: MEASURED_COLUMNS,
        rows,
      },
      null,
      2
    ) + '\n'
  );
  return { rows };
}

// --- The AI server ---

// Asks GET /api/bridge (what the server runs; the dev server answers it too) and checks that it
// can run every model the matches to play need. Fails fast with what to do.
async function checkServer(origin: string, todo: MatchDef[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${origin}/api/bridge`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
    throw new RunError(
      `Cannot reach the AI server at ${origin} (${cause}). Start it first: npm run dev (LLM, Jev and Snap) or the AI bridge (LLM only), or give its address with --ai-server.`
    );
  }
  if (res.headers.get('x-ai-access') === 'denied')
    throw new RunError(
      `The AI server at ${origin} refused the runner (its access guard, HTTP ${res.status}).`
    );
  if (res.status === 404) {
    res.body?.cancel().catch(() => undefined);
    console.log(
      `AI server ${origin}: it does not say what it runs (no GET /api/bridge, an older version); its answers will tell.`
    );
    return null;
  }
  const body = await statusBody(res, 'an AI server status');
  if (typeof body === 'string')
    throw new RunError(`The AI server at ${origin} did not answer as one: ${body}.`);
  const status = body as Json;
  const runs = readRuns(status.llm);
  const problems = new Set<string>();
  const tactical = todo.some((m) => tacticalOf(m.west) || tacticalOf(m.east));
  if (status.bridge === true && tactical)
    problems.add(
      'it is the AI bridge, which has no /api/jev or /api/snap: LLM + Jev and LLM + Snap need npm run dev'
    );
  const models = new Set(todo.flatMap((m) => [m.west, m.east].filter(usesAi).map((s) => s.model!)));
  for (const model of models) {
    const local = localModelId(model);
    const codex = codexModel(model);
    const tool = cliToolOf(model);
    if (['haiku', 'sonnet', 'opus'].includes(model) && !runs.claude)
      problems.add(`${model}: it cannot run Claude (no Agent SDK there)`);
    else if (openRouterId(model) !== null && !runs.openrouter)
      problems.add(`${model}: it has no OPENROUTER_API_KEY`);
    else if (local !== null && (!runs.localUrl || (runs.models && !runs.models.includes(local))))
      problems.add(
        `${model}: its local model server ${runs.localUrl ? 'does not list it' : 'cannot be used (LOCAL_LLM_URL)'}`
      );
    else if (codex !== null && runs.codex?.available === false)
      problems.add(`${model}: Codex cannot run there (${runs.codex.reason || 'not found'})`);
    else if (geminiModelId(model) !== null && runs.gemini === false)
      problems.add(`${model}: it has no GEMINI_API_KEY`);
    else if (
      tool !== null &&
      runs.custom &&
      !runs.custom.some((c) => c.id === model && c.available)
    )
      problems.add(`${model}: it has no such command (CLI_TOOL_${tool.toUpperCase()})`);
  }
  if (problems.size)
    throw new RunError(
      `The AI server at ${origin} cannot run this plan: ${[...problems].join('; ')}.`
    );
  return status;
}

// A layer that stopped for a reason that will not pass by itself (a refused key, a model the
// server cannot run, a budget or plan limit, an error in our own code) stops the whole run: the
// next matches would only lose the same layer. Failures that may pass (three in a row, a timeout)
// and a tactical layer that stopped with its LLM do not.
export function lastingStop(failure: string): boolean {
  return !(
    failure.includes('failed requests in a row') ||
    failure.startsWith('no answer within') ||
    /stopped; (tactical|strategic) layer stopped with it/.test(failure)
  );
}

// --- Running ---

interface Running {
  def: MatchDef;
  worker: Worker;
  spent: number;
  t: number;
  started: number;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const x = readPlan(args.plan, {
    out: args.out,
    aiServer: args.aiServer,
    maxMatches: args.maxMatches,
  });
  const parallel = args.parallel ?? x.plan.parallel ?? 1;
  // A dry run writes nothing, not even the results folder
  const leftovers = args.dryRun ? [] : removeLeftovers(x.out);
  const folder = readFolder(x);
  const todo = x.matches.filter((m) => !folder.finished.has(`${m.key}.${m.hash}`));
  const cap = x.plan.spendCapUsd ?? null;
  // Paths below the working folder as relative ones, others in full
  const shown = (p: string) => {
    const r = relative(process.cwd(), p);
    return r && !r.startsWith('..') ? r : p;
  };

  console.log(
    `Plan "${x.plan.name}" (${shown(x.file)}), plan hash ${x.hash}; results in ${shown(x.out)}`
  );
  const seeds = seedList(x.plan.seeds).length;
  console.log(
    `${x.allMatches} matches: ${x.plan.conditions.length} conditions × ${x.plan.objectives.length} objectives × ${x.plan.maps.length} maps × ${seeds} seeds × ${x.plan.swapSides ? 2 : 1} side assignments${x.matches.length < x.allMatches ? `; maxMatches keeps the first ${x.matches.length}` : ''}`
  );
  console.log(`  finished: ${x.matches.length - todo.length}; to play: ${todo.length}`);
  if (leftovers.length)
    console.log(`  removed ${leftovers.length} unfinished file(s) of a killed run`);
  if (folder.unreadable.length)
    console.log(`  unreadable files (not counted): ${folder.unreadable.join(', ')}`);
  if (folder.notInPlan.length)
    console.log(
      `  ${folder.notInPlan.length} file(s) of matches not in this plan (left as they are)`
    );
  const spentBefore = folder.spentFinished + folder.spentAbandoned;

  if (args.dryRun) {
    dryRun(x, todo, parallel, cap, spentBefore);
    return 0;
  }
  if (todo.length === 0) {
    writeSummary(x);
    console.log('Nothing to play: every match of the plan is finished. Summary written.');
    return 0;
  }
  if (cap !== null && spentBefore >= cap) {
    writeSummary(x);
    console.log(
      `The spend cap is reached (${usd(spentBefore)} of ${usd(cap)} reported). Raise spendCapUsd in the plan to go on.`
    );
    return 3;
  }

  ensureDir(join(x.out, MATCHES_DIR));
  const code = codeVersion();
  const aiTodo = todo.some((m) => usesAi(m.west) || usesAi(m.east));
  const status = aiTodo && x.aiServer ? await checkServer(x.aiServer, todo) : null;
  if (aiTodo) console.log(`AI server ${x.aiServer}: reached`);
  const session = {
    startedAt: new Date().toISOString(),
    planHash: x.hash,
    planFile: x.file,
    code,
    node: process.version,
    aiServer: x.aiServer,
    aiServerStatus: status,
    parallel,
    spendCapUsd: cap,
  };
  writeAtomic(
    join(x.out, 'run.json'),
    JSON.stringify(
      {
        plan: x.plan,
        planFile: x.file,
        planHash: x.hash,
        allMatches: x.allMatches,
        matches: x.matches.map(({ mapGrid: _grid, ...m }) => m),
      },
      null,
      2
    ) + '\n'
  );
  if (parallel > Math.max(1, cpus().length - 1) && todo.some((m) => m.timing === 'realtime'))
    console.log(
      `  note: ${parallel} paced matches at once on ${cpus().length} cores may fall behind real time (recorded per match)`
    );

  // --- The schedule ---
  const pending = [...todo];
  const running = new Map<string, Running>();
  let spent = spentBefore;
  let stopping: null | 'finish' | 'abandon' = null;
  let why = '';
  let exit = 0;
  let played = 0;
  let abandoned = 0;
  let startedCount = 0;
  let wake: () => void = () => {};
  const changed = () => wake();

  const ledger = (r: Running, how: string) => {
    appendFileSync(
      join(x.out, 'abandoned.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        key: r.def.key,
        hash: r.def.hash,
        how,
        reportedCostUsd: Math.round(r.spent * 1e6) / 1e6,
      }) + '\n'
    );
  };
  const abandonAll = (how: string) => {
    for (const r of running.values()) {
      void r.worker.terminate();
      ledger(r, how);
      abandoned++;
      console.log(`  abandoned ${r.def.key} at ${r.t.toFixed(0)} s (${how}); no file written`);
    }
    running.clear();
    changed();
  };

  const onSignal = (signal: string) => {
    if (signal === 'SIGINT' && stopping === null) {
      stopping = 'finish';
      why = 'interrupted';
      exit = 130;
      console.log(
        `\nNo new matches; ${running.size} running will finish. Ctrl+C again abandons them (no files).`
      );
    } else {
      stopping = 'abandon';
      why = 'interrupted';
      exit = 130;
      abandonAll('interrupted');
    }
    changed();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  // At most one running match per LLM side: the AI server keeps one LLM session per side
  // (server/llmEndpoint.ts), and two matches on one side would take it from each other
  const busy = (side: 'west' | 'east') => [...running.values()].some((r) => usesAi(r.def[side]));
  const fits = (d: MatchDef) =>
    !(usesAi(d.west) && busy('west')) && !(usesAi(d.east) && busy('east'));

  const start = (d: MatchDef) => {
    const job: MatchJob = {
      def: d,
      aiServer: x.aiServer,
      plan: { name: x.plan.name, hash: x.hash, file: x.file },
      code,
      aiServerStatus: status,
    };
    const worker = new Worker(WORKER, { workerData: { job } });
    const r: Running = { def: d, worker, spent: 0, t: 0, started: Date.now() };
    running.set(d.key, r);
    startedCount++;
    console.log(
      `[${startedCount}/${todo.length}] start ${d.key}: ${sideText(d.west)} (West) vs ${sideText(d.east)} (East), seed ${d.seed}, ${d.timing}`
    );
    let over = false;
    worker.on('message', (m: FromWorker) => {
      if (over || !running.has(d.key)) return;
      if (m.type === 'spend') {
        r.spent += m.usd;
        spent += m.usd;
        if (cap !== null && spent >= cap && stopping !== 'abandon') {
          stopping = 'abandon';
          why = 'spend cap';
          exit = 3;
          console.log(`Spend cap reached: ${usd(spent)} of ${usd(cap)} reported. Stopping.`);
          abandonAll('spend cap');
        }
      } else if (m.type === 'progress') r.t = m.t;
      else if (m.type === 'done') {
        over = true;
        const log = JSON.parse(m.log) as Json;
        writeAtomic(join(x.out, MATCHES_DIR, matchFileName(d.key, d.hash)), m.log);
        running.delete(d.key);
        played++;
        void worker.terminate();
        report(log, d);
        // Its last answers' cost came with it: the match is kept even when that reaches the cap
        spent += m.usd;
        if (cap !== null && spent >= cap && stopping !== 'abandon') {
          stopping = 'abandon';
          why = 'spend cap';
          exit = 3;
          console.log(`Spend cap reached: ${usd(spent)} of ${usd(cap)} reported. Stopping.`);
          abandonAll('spend cap');
        }
        changed();
      } else if (m.type === 'failed') {
        over = true;
        running.delete(d.key);
        ledger(r, 'runner failed');
        void worker.terminate();
        console.error(
          `  ${d.key}: the runner failed (not recorded; played again next time):\n${m.message}`
        );
        if (exit === 0) exit = 1;
        changed();
      }
    });
    worker.on('error', (err: Error) => {
      if (over || !running.has(d.key)) return;
      over = true;
      running.delete(d.key);
      ledger(r, 'runner failed');
      console.error(`  ${d.key}: the runner failed (not recorded): ${err.stack ?? err.message}`);
      if (exit === 0) exit = 1;
      changed();
    });
    worker.on('exit', () => {
      if (over || !running.has(d.key)) return;
      over = true;
      running.delete(d.key);
      ledger(r, 'worker ended');
      console.error(`  ${d.key}: its worker ended without a result (not recorded)`);
      if (exit === 0) exit = 1;
      changed();
    });
  };

  const report = (log: Json, d: MatchDef) => {
    const row = matchRow(log);
    const result =
      row.status === 'finished'
        ? `subject ${row.subject_result} (${row.end_reason}, ${row.game_seconds} s)`
        : row.status === 'error'
          ? `stopped by an error: ${row.error}`
          : `not finished (stopped at ${row.game_seconds} s)`;
    const cost = ['subject_llm_cost_usd', 'opponent_llm_cost_usd']
      .map((c) => row[c])
      .filter((v): v is number => typeof v === 'number');
    // Why a layer stopped, in full from the match log (the row keeps 300 characters)
    const failures: string[] = [];
    const ai = (log.ai ?? {}) as Record<string, Json | null>;
    for (const side of ['west', 'east'])
      for (const layer of ['llm', 'jev']) {
        const failure = (ai[side]?.[layer] as Json | undefined)?.failure;
        if (typeof failure === 'string') failures.push(failure);
      }
    console.log(
      `  done ${d.key}: ${result}; wall ${duration(Number(row.wall_seconds))}${cost.length ? `; reported ${usd(cost.reduce((a, v) => a + v, 0))}` : ''}${row.realtime_fell_behind === true ? `; FELL BEHIND real time by ${row.realtime_lag_seconds} s` : ''}`
    );
    for (const role of ROLES)
      if (row[`${role}_stopped`] === true)
        console.log(`    ${role} stopped: ${row[`${role}_stop_reason`]}`);
    if (failures.some(lastingStop) && stopping === null) {
      stopping = 'finish';
      why = 'a layer was refused';
      exit = 1;
      console.log(
        `  A layer stopped for a reason that will not pass by itself; no new matches (the match is recorded). Fix it and run the plan again.`
      );
    }
  };

  const statusTimer = setInterval(() => {
    if (!running.size) return;
    console.log(
      `  … ${[...running.values()].map((r) => `${r.def.key} t=${r.t.toFixed(0)} s`).join('; ')}; played ${played} of ${todo.length}; reported ${usd(spent)}`
    );
  }, STATUS_EVERY_MS);

  for (;;) {
    while (stopping === null && running.size < parallel) {
      if (cap !== null && spent >= cap) {
        stopping = 'finish';
        why = 'spend cap';
        exit = 3;
        break;
      }
      const i = pending.findIndex(fits);
      if (i < 0) break;
      start(pending.splice(i, 1)[0]);
    }
    if (running.size === 0 && (stopping !== null || pending.length === 0)) break;
    await new Promise<void>((r) => (wake = r));
  }
  clearInterval(statusTimer);

  const { rows } = writeSummary(x);
  const done = rows.length;
  appendFileSync(
    join(x.out, 'sessions.jsonl'),
    JSON.stringify({
      ...session,
      endedAt: new Date().toISOString(),
      ended: why || 'complete',
      played,
      abandoned,
      reportedCostUsd: Math.round((spent - spentBefore) * 1e6) / 1e6,
    }) + '\n'
  );
  console.log(
    `${why ? `Stopped (${why})` : 'Done'}: played ${played}, abandoned ${abandoned}; ${done} of ${x.matches.length} matches of the plan finished; reported cost this time ${usd(spent - spentBefore)}, in all ${usd(spent)}${cap !== null ? ` (cap ${usd(cap)})` : ''}.`
  );
  console.log(`Summary: ${shown(join(x.out, 'summary.csv'))}`);
  return exit;
}

function dryRun(
  x: ExpandedPlan,
  todo: MatchDef[],
  parallel: number,
  cap: number | null,
  spentBefore: number
): void {
  const est = todo.map((d) => ({ d, e: estimate(d, x.plan) }));
  const sum = (f: (e: Estimate) => number) => est.reduce((a, { e }) => a + f(e), 0);
  const sequential = sum((e) => e.wallSeconds);
  const side = (s: 'west' | 'east') =>
    est.filter(({ d }) => usesAi(d[s])).reduce((a, { e }) => a + e.wallSeconds, 0);
  const atOnce = Math.max(sequential / parallel, side('west'), side('east'));
  console.log(
    `AI server: ${x.aiServer ?? 'none needed (no AI layer)'}${x.aiServer ? ' (not asked in a dry run)' : ''}`
  );
  console.log(
    `Parallel: ${parallel} (at most one match at a time per LLM side: the AI server keeps one LLM session per side)`
  );
  console.log(
    'Estimated (upper bounds: every match to its time limit; see experiments/README.md):'
  );
  console.log(
    `  requests: LLM ${sum((e) => e.llmRequests)}, Jev/Snap ${sum((e) => e.tacticalRequests)}`
  );
  console.log(`  duration: about ${duration(atOnce)} (one after another: ${duration(sequential)})`);
  const costs = est.map(({ e }) => e.usd);
  console.log(
    costs.some((c) => c === null)
      ? '  cost: no per-request estimate in the plan (estimates.llmRequestUsd, estimates.tacticalRequestUsd)'
      : `  cost: about ${usd(sum((e) => e.usd ?? 0))} (estimate)`
  );
  console.log(
    `Spend cap: ${cap === null ? 'none' : usd(cap)}; reported so far in this folder: ${usd(spentBefore)}`
  );
  const perCondition = new Map<string, number>();
  for (const d of todo) perCondition.set(d.condition, (perCondition.get(d.condition) ?? 0) + 1);
  for (const [c, n] of perCondition) console.log(`  ${c}: ${n} to play`);
  console.log('Matches to play, in plan order:');
  for (const { d, e } of est)
    console.log(
      `  ${String(d.index + 1).padStart(4)} ${d.key}  ${sideText(d.west)} vs ${sideText(d.east)}  ${d.timing}  ≤${e.gameSeconds} s game, ~${duration(e.wallSeconds)}${e.usd !== null ? `, ~${usd(e.usd)}` : ''}`
    );
  console.log('Nothing was played (dry run).');
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof RunError || err instanceof PlanError) {
      console.error(err.message);
      process.exit(err instanceof PlanError ? 2 : 1);
    }
    console.error(err);
    process.exit(1);
  }
);
