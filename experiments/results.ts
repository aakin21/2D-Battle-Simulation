// What a results folder holds and how it is read and written: one file per finished match (the
// match log of src/ui/MatchLog.ts with an `experiment` block), written whole or not at all; the
// summary table (a row per match, built from those files only); the reproducibility hash.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonical } from './plan';
import { maxOf, mean, median, p90 } from './stats';

export type Json = Record<string, unknown>;

// --- Files ---

export const MATCHES_DIR = 'matches';

export function matchFileName(key: string, hash: string): string {
  return `${key}.${hash}.json`;
}

// Written to a temporary file in the same folder, flushed, then renamed over the name: a reader
// (or a run started again after a kill) sees the whole file or none
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

// Temporary files a killed run left behind (never a finished match)
export function removeLeftovers(dir: string): string[] {
  const gone: string[] = [];
  for (const sub of [dir, join(dir, MATCHES_DIR), join(dir, 'analysis')]) {
    if (!existsSync(sub)) continue;
    for (const name of readdirSync(sub))
      if (name.endsWith('.tmp')) {
        rmSync(join(sub, name), { force: true });
        gone.push(join(sub, name));
      }
  }
  return gone;
}

export interface MatchFile {
  file: string;
  key: string;
  hash: string;
  log: Json;
}

// Every finished match in the folder; files that cannot be read are listed, not used
export function readMatchFiles(dir: string): { files: MatchFile[]; unreadable: string[] } {
  const folder = join(dir, MATCHES_DIR);
  const files: MatchFile[] = [];
  const unreadable: string[] = [];
  if (!existsSync(folder)) return { files, unreadable };
  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const log = JSON.parse(readFileSync(join(folder, name), 'utf8')) as Json;
      const match = (log.experiment as Json | undefined)?.match as Json | undefined;
      if (typeof match?.key !== 'string' || typeof match.hash !== 'string')
        throw new Error('no experiment block');
      files.push({ file: name, key: match.key, hash: match.hash, log });
    } catch {
      unreadable.push(name);
    }
  }
  return { files, unreadable };
}

// --- Reproducibility ---

// Fields that differ between two plays of the same match with the same answers: clock times,
// answer times (the browser's and the server's), the LLM's per-match session id, the code
// version and the runner's own record (`experiment`). Everything else is the outcome.
export const VOLATILE_TOP = ['startedAt', 'savedAt', 'version', 'experiment'];
export const VOLATILE_ANYWHERE = ['latencyMs', 'apiMs', 'matchId'];

export function withoutVolatile(log: Json): unknown {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out: Json = {};
      for (const [k, x] of Object.entries(v as Json))
        if (!VOLATILE_ANYWHERE.includes(k)) out[k] = strip(x);
      return out;
    }
    return v;
  };
  const top: Json = {};
  for (const [k, v] of Object.entries(log)) if (!VOLATILE_TOP.includes(k)) top[k] = strip(v);
  return top;
}

// SHA-256 of the match log without its volatile fields (16 hex): the same in two plays of a
// match that got the same answers
export function outcomeHash(log: Json): string {
  return createHash('sha256')
    .update(canonical(withoutVolatile(log)))
    .digest('hex')
    .slice(0, 16);
}

// --- The summary row ---

type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

export const ROLES = ['subject_llm', 'subject_tactical', 'opponent_llm', 'opponent_tactical'];

// Columns that are measurements of time (they differ between two plays with the same answers);
// the README lists them
export const MEASURED_COLUMNS = [
  ...ROLES.flatMap((r) => [
    `${r}_latency_mean_ms`,
    `${r}_latency_median_ms`,
    `${r}_latency_p90_ms`,
    `${r}_latency_max_ms`,
    `${r}_game_latency_mean_s`,
    `${r}_game_latency_max_s`,
  ]),
  'wall_seconds',
  'realtime_lag_seconds',
  'realtime_fell_behind',
  'answers_held',
  'started_at',
];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const round = (v: number | null, digits: number): number | null =>
  v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;
const sumOf = (values: (number | null)[]): number | null =>
  values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null;

// The answer times (ms) of a layer's requests that were answered
export function answerTimes(layer: Json): number[] {
  return arr(layer.exchanges)
    .map(obj)
    .filter((x) => x.error === null && num(x.latencyMs) !== null)
    .map((x) => x.latencyMs as number);
}

function layerCells(
  prefix: string,
  layer: Json | null,
  kind: 'llm' | 'tactical',
  seen: Json[],
  model: string | null
): Row {
  const row: Row = {};
  const exchanges = layer ? arr(layer.exchanges).map(obj) : [];
  const times = layer ? answerTimes(layer) : [];
  const game = seen
    .filter((s) => num(s.arrivedAt) !== null && num(s.sentAt) !== null)
    .map((s) => (s.arrivedAt as number) - (s.sentAt as number));
  const decisions = layer ? arr(layer.decisions).map(obj) : [];
  const usage = decisions.map((d) => obj(d.usage));
  row[`${prefix}_model`] = layer ? (kind === 'llm' ? model : (str(layer.model) ?? null)) : null;
  row[`${prefix}_requests`] = layer ? exchanges.length : null;
  row[`${prefix}_failed`] = layer
    ? exchanges.filter((x) => x.error !== null && x.error !== undefined).length
    : null;
  row[`${prefix}_skipped`] = layer ? (num(layer.skippedRequests) ?? 0) : null;
  row[`${prefix}_latency_mean_ms`] = round(mean(times), 1);
  row[`${prefix}_latency_median_ms`] = round(median(times), 1);
  row[`${prefix}_latency_p90_ms`] = round(p90(times), 1);
  row[`${prefix}_latency_max_ms`] = round(maxOf(times), 1);
  row[`${prefix}_game_latency_mean_s`] = round(mean(game), 4);
  row[`${prefix}_game_latency_max_s`] = round(maxOf(game), 4);
  if (kind === 'llm') {
    row[`${prefix}_input_tokens`] = layer ? sumOf(usage.map((u) => num(u.inputTokens))) : null;
    row[`${prefix}_output_tokens`] = layer ? sumOf(usage.map((u) => num(u.outputTokens))) : null;
    row[`${prefix}_cache_read_tokens`] = layer
      ? sumOf(usage.map((u) => num(u.cacheReadTokens)))
      : null;
    row[`${prefix}_cache_write_tokens`] = layer
      ? sumOf(usage.map((u) => num(u.cacheWriteTokens)))
      : null;
    row[`${prefix}_cost_usd`] = layer ? round(sumOf(usage.map((u) => num(u.costUsd))), 6) : null;
  } else {
    // Jev and Snap report the request's input tokens and no cost
    row[`${prefix}_input_tokens`] = layer
      ? sumOf(exchanges.map((x) => num(obj(obj(x.response).usage).input_tokens)))
      : null;
    row[`${prefix}_output_tokens`] = null;
    row[`${prefix}_cache_read_tokens`] = null;
    row[`${prefix}_cache_write_tokens`] = null;
    row[`${prefix}_cost_usd`] = null;
  }
  const failure = layer ? str(layer.failure) : null;
  row[`${prefix}_stopped`] = layer ? failure !== null : null;
  row[`${prefix}_stop_reason`] = failure === null ? null : failure.slice(0, 300);
  return row;
}

function sideCells(prefix: string, first: Json, last: Json): Row {
  const a = obj(first);
  const b = obj(last);
  return {
    [`${prefix}_soldiers_start`]: num(a.soldiers),
    [`${prefix}_soldiers_lost`]:
      num(a.soldiers) !== null && num(b.soldiers) !== null
        ? (a.soldiers as number) - (b.soldiers as number)
        : null,
    [`${prefix}_heroes_start`]: num(a.heroes),
    [`${prefix}_heroes_lost`]:
      num(a.heroes) !== null && num(b.heroes) !== null
        ? (a.heroes as number) - (b.heroes as number)
        : null,
    [`${prefix}_hp_left`]: num(b.hp),
    [`${prefix}_points`]: num(b.points),
    [`${prefix}_base_hp_pct`]: num(b.baseHpPercent),
  };
}

// A summary row from a match file alone
export function matchRow(log: Json): Row {
  const e = obj(log.experiment);
  const m = obj(e.match);
  const sides = obj(e.sides);
  const settings = obj(log.settings);
  const subject = m.subjectSide === 'east' ? 'east' : 'west';
  const opponent = subject === 'west' ? 'east' : 'west';
  const result = log.result;
  const r = obj(result);
  const status =
    typeof result === 'object' && result !== null && 'winner' in r
      ? 'finished'
      : 'stoppedByError' in r
        ? 'error'
        : 'not finished';
  const winner = status === 'finished' ? (str(r.winner) ?? null) : null;
  const timeline = arr(log.timeline).map(obj);
  const first = timeline[0] ?? {};
  const last = timeline[timeline.length - 1] ?? {};
  const ai = obj(log.ai);
  const seen = arr(e.requests).map(obj);
  const sideOf = (s: string) => obj(sides[s]);
  const pacing = obj(e.pacing);
  const row: Row = {
    key: str(m.key),
    match_hash: str(m.hash),
    plan_hash: str(obj(e.plan).hash),
    condition: str(m.condition),
    objective: str(m.objective),
    map: str(m.map),
    seed: num(m.seed),
    subject_side: subject,
    timing: str(m.timing),
    west_commander: str(sideOf('west').commander),
    west_model: str(sideOf('west').model),
    east_commander: str(sideOf('east').commander),
    east_model: str(sideOf('east').model),
    status,
    winner_side: winner,
    subject_result:
      winner === null ? null : winner === 'draw' ? 'draw' : winner === subject ? 'win' : 'loss',
    end_reason: status === 'finished' ? str(r.reason) : status === 'error' ? 'error' : 'stopped',
    game_seconds: status === 'finished' ? num(r.time) : num(last.t),
    ...sideCells('subject', obj(first[subject]), obj(last[subject])),
    ...sideCells('opponent', obj(first[opponent]), obj(last[opponent])),
  };
  for (const [prefix, side] of [
    ['subject', subject],
    ['opponent', opponent],
  ] as const) {
    const layers = ai[side] === null ? {} : obj(ai[side]);
    const model = str(settings[`${side}Model`]);
    Object.assign(
      row,
      layerCells(
        `${prefix}_llm`,
        layers.llm ? obj(layers.llm) : null,
        'llm',
        seen.filter((s) => s.layer === `${side}.llm`),
        model
      ),
      layerCells(
        `${prefix}_tactical`,
        layers.jev ? obj(layers.jev) : null,
        'tactical',
        seen.filter((s) => s.layer === `${side}.tactical`),
        null
      )
    );
  }
  Object.assign(row, {
    wall_seconds: num(e.wallSeconds),
    realtime_lag_seconds: num(pacing.lagSeconds),
    realtime_fell_behind: typeof pacing.fellBehind === 'boolean' ? pacing.fellBehind : null,
    answers_held: num(e.answersHeld),
    refused_requests: num(e.refusedRequests),
    error: status === 'error' ? (str(r.stoppedByError)?.slice(0, 300) ?? null) : null,
    final_state_hash: str(e.finalStateHash),
    outcome_hash: str(e.outcomeHash),
    started_at: str(e.startedAt),
    code_version: str(log.version),
  });
  return row;
}

// --- CSV (RFC 4180: a field with a comma, quote or line break is quoted, quotes doubled) ---

export function csvCell(v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  rows: Row[],
  columns: string[] = rows.length ? Object.keys(rows[0]) : []
): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  return lines.join('\n') + '\n';
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
