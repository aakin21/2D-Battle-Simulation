// The experiment plan (a JSON file): what to play, how, and where the results go. This file is
// its schema (the interfaces below, every field documented), its check (`readPlan`: unknown
// fields are refused, so a typo such as "spendcap" never silently switches the cap off) and its
// expansion into matches (`expandPlan`). An example: experiments/plan.example.json.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGrid, encodeGrid } from '../src/state/MapStore';
import { FIXED_MAP } from '../src/maps/fixedMap';
import { isLlmModel } from '../src/ai/Models';
import type { AITiming, Objective, TerrainDensity } from '../src/types/types';

// Who commands a side: the rule layer, the LLM alone, or the LLM with a tactical layer (D38, D51)
export type Commander = 'rules' | 'llm' | 'llm+jev' | 'llm+snap';
export const COMMANDERS: Commander[] = ['rules', 'llm', 'llm+jev', 'llm+snap'];

export interface SideSpec {
  commander: Commander;
  // The LLM, as the menu's ids (src/ai/Models.ts): "haiku", "sonnet", "opus", "openrouter:<id>",
  // "local:<name>", "codex[:<model>]", "gemini:<model>", "cli:<name>". Required for an LLM
  // commander, refused for "rules".
  model?: string;
}

// A condition: a named pair of sides. The subject is the side under study (its win rate is the
// condition's); the opponent is what it plays against. With swapSides every match is played
// twice, the subject once as West and once as East, on the same map with the same seed.
export interface ConditionSpec {
  name: string; // letters, digits, spaces, ".", "_", "+", "-" (at most 64); unique
  subject: SideSpec;
  opponent: SideSpec;
  timing?: AITiming; // this condition's AI timing; the plan's `timing` when absent
}

// A map: a new random map made from each match's seed ("random"), the fixed map of D5 ("fixed"),
// or a saved one: a file holding the text "Save this map" stores (MapStore.encodeGrid, it begins
// "v1;150;"), or the browser's whole saved-maps object (localStorage "sim_maps") with `name`
// naming the map in it. A relative path is taken from the plan file's folder.
export type MapSpec = 'random' | 'fixed' | { saved: string; name?: string };

export interface Estimates {
  llmRequestUsd?: number; // estimated cost of one LLM request (for --dry-run only)
  tacticalRequestUsd?: number; // estimated cost of one Jev or Snap request (for --dry-run only)
  llmAnswerSeconds?: number; // typical LLM answer time (paused timing's duration estimate)
  tacticalAnswerSeconds?: number; // typical Jev or Snap answer time
}

export interface Plan {
  name: string; // the plan's name: the default results folder's name (letters, digits, . _ -)
  // Where /api/llm, /api/jev, /api/snap and /api/bridge are: the author's `npm run dev`
  // (http://127.0.0.1:5173) or the AI bridge (http://127.0.0.1:8642, LLM only). On this computer
  // only. Not asked when no condition uses an AI layer. `--ai-server` overrides it.
  aiServer?: string;
  conditions: ConditionSpec[];
  objectives: Objective[]; // each condition is played on each objective (D30)
  maps: MapSpec[]; // ... and on each map
  soldiers?: number; // soldiers per side (default 150, BATTLE_CONFIG; 0–2000 as in the menu)
  terrain?: TerrainDensity; // a random map's terrain (default "normal")
  timing: AITiming; // "paused" (the battle waits for every answer) or "realtime" (D4)
  // The seeds: a list, or `count` seeds from `base` (base, base+1, ...; base 1 by default)
  seeds: number[] | { count: number; base?: number };
  swapSides?: boolean; // every match also with the sides swapped (default true; Q9, R13)
  // Stop each match at this simulation time (seconds) instead of its end: a smoke run. Such a
  // match is recorded as "not finished" and has no winner. Default: none.
  stopAtSeconds?: number | null;
  // --- How the run goes; none of these changes a match (they are not in any match's hash) ---
  parallel?: number; // matches played at once (default 1); see "LLM sessions" in the README
  // The run stops when the costs the answers report reach this (USD, over every invocation in
  // the results folder). Required when a condition uses an AI layer; null: no cap.
  spendCapUsd?: number | null;
  maxMatches?: number | null; // play only the plan's first N matches (in plan order)
  out?: string; // the results folder (default experiments/results/<name>)
  estimates?: Estimates; // for --dry-run only
}

// One match of the plan, everything that decides it
export interface MatchDef {
  index: number; // position in plan order
  key: string; // condition.objective.map.s<seed>.<subject side>, unique in the plan
  hash: string; // of everything that decides the match (12 hex); part of its file name
  condition: string;
  objective: Objective;
  map: string; // "random", "fixed" or "saved: <name>" (the match log's label)
  mapGrid: string | null; // the map's text (encodeGrid) for a fixed or saved map; null: random
  mapHash: string | null; // of mapGrid
  seed: number;
  subjectSide: 'west' | 'east';
  west: SideSpec;
  east: SideSpec;
  timing: AITiming;
  soldiers: number;
  terrain: TerrainDensity;
  stopAtSeconds: number | null;
}

export interface ExpandedPlan {
  plan: Plan;
  file: string; // the plan file, absolute
  hash: string; // of every match's definition, in order (12 hex)
  matches: MatchDef[]; // after maxMatches
  allMatches: number; // before maxMatches
  out: string; // the results folder, absolute
  aiServer: string | null; // origin, or null when no condition needs one
}

export const DEFAULT_AI_SERVER = 'http://127.0.0.1:5173';
const DEFAULT_SOLDIERS = 150;
const OBJECTIVES: Objective[] = ['elimination', 'control', 'base'];
const TERRAINS: TerrainDensity[] = ['light', 'normal', 'dense'];
const TIMINGS: AITiming[] = ['paused', 'realtime'];

export class PlanError extends Error {}

export function usesAi(side: SideSpec): boolean {
  return side.commander !== 'rules';
}

// The tactical layer of a side, or null
export function tacticalOf(side: SideSpec): 'jev' | 'snap' | null {
  return side.commander === 'llm+jev' ? 'jev' : side.commander === 'llm+snap' ? 'snap' : null;
}

export function sideText(side: SideSpec): string {
  return side.commander === 'rules' ? 'rules' : `${side.commander}:${side.model}`;
}

// JSON with sorted keys, so a hash does not depend on the order fields were written in
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// --- Checking ---

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function only(o: Obj, where: string, allowed: string[]): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k))
      throw new PlanError(`${where}: unknown field "${k}" (allowed: ${allowed.join(', ')})`);
}

function wholeNumber(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new PlanError(`${where}: a whole number from ${min} to ${max} is needed`);
  return v;
}

function positive(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
    throw new PlanError(`${where}: a number of 0 or more is needed`);
  return v;
}

function oneOf<T extends string>(v: unknown, where: string, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T))
    throw new PlanError(`${where}: one of ${values.map((x) => `"${x}"`).join(', ')} is needed`);
  return v as T;
}

function checkSide(v: unknown, where: string): SideSpec {
  if (!isObj(v)) throw new PlanError(`${where}: { "commander", "model" } is needed`);
  only(v, where, ['commander', 'model']);
  const commander = oneOf(v.commander, `${where}.commander`, COMMANDERS);
  if (commander === 'rules') {
    if (v.model !== undefined) throw new PlanError(`${where}.model: the rules have no model`);
    return { commander };
  }
  if (!isLlmModel(v.model))
    throw new PlanError(
      `${where}.model: an LLM model is needed ("haiku", "sonnet", "opus", "openrouter:<id>", "local:<name>", "codex", "codex:<model>", "gemini:<model>", "cli:<name>")`
    );
  return { commander, model: v.model };
}

const CONDITION_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/;
const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The plan as written, checked. Throws PlanError saying what is wrong and where.
export function checkPlan(raw: unknown): Plan {
  if (!isObj(raw)) throw new PlanError('the plan must be a JSON object');
  only(raw, 'plan', [
    '$comment',
    'name',
    'aiServer',
    'conditions',
    'objectives',
    'maps',
    'soldiers',
    'terrain',
    'timing',
    'seeds',
    'swapSides',
    'stopAtSeconds',
    'parallel',
    'spendCapUsd',
    'maxMatches',
    'out',
    'estimates',
  ]);
  if (typeof raw.name !== 'string' || !PLAN_NAME.test(raw.name))
    throw new PlanError('name: letters, digits, ".", "_" or "-" (at most 64) are needed');
  if (raw.aiServer !== undefined && typeof raw.aiServer !== 'string')
    throw new PlanError('aiServer: an address such as "http://127.0.0.1:5173" is needed');

  if (!Array.isArray(raw.conditions) || raw.conditions.length === 0)
    throw new PlanError('conditions: a list of at least one condition is needed');
  const names = new Set<string>();
  const conditions = raw.conditions.map((c, i): ConditionSpec => {
    const where = `conditions[${i}]`;
    if (!isObj(c)) throw new PlanError(`${where}: { "name", "subject", "opponent" } is needed`);
    only(c, where, ['name', 'subject', 'opponent', 'timing']);
    if (typeof c.name !== 'string' || !CONDITION_NAME.test(c.name))
      throw new PlanError(
        `${where}.name: letters, digits, spaces, ".", "_", "+" or "-" (at most 64) are needed`
      );
    if (names.has(slug(c.name))) throw new PlanError(`${where}.name: "${c.name}" is used twice`);
    names.add(slug(c.name));
    return {
      name: c.name,
      subject: checkSide(c.subject, `${where}.subject`),
      opponent: checkSide(c.opponent, `${where}.opponent`),
      ...(c.timing !== undefined ? { timing: oneOf(c.timing, `${where}.timing`, TIMINGS) } : {}),
    };
  });

  if (!Array.isArray(raw.objectives) || raw.objectives.length === 0)
    throw new PlanError('objectives: a list such as ["control"] is needed');
  const objectives = raw.objectives.map((o, i) => oneOf(o, `objectives[${i}]`, OBJECTIVES));
  if (new Set(objectives).size !== objectives.length)
    throw new PlanError('objectives: an objective is listed twice');

  if (!Array.isArray(raw.maps) || raw.maps.length === 0)
    throw new PlanError('maps: a list such as ["fixed"] is needed');
  const maps = raw.maps.map((m, i): MapSpec => {
    const where = `maps[${i}]`;
    if (m === 'random' || m === 'fixed') return m;
    if (!isObj(m) || typeof m.saved !== 'string' || !m.saved)
      throw new PlanError(`${where}: "random", "fixed" or { "saved": "<file>" } is needed`);
    only(m, where, ['saved', 'name']);
    if (m.name !== undefined && (typeof m.name !== 'string' || !m.name))
      throw new PlanError(`${where}.name: the saved map's name is needed`);
    return { saved: m.saved, ...(m.name !== undefined ? { name: m.name as string } : {}) };
  });

  const timing = oneOf(raw.timing, 'timing', TIMINGS);
  let seeds: Plan['seeds'];
  if (Array.isArray(raw.seeds)) {
    if (raw.seeds.length === 0) throw new PlanError('seeds: at least one seed is needed');
    seeds = raw.seeds.map((s, i) => wholeNumber(s, `seeds[${i}]`, 0, 2 ** 31 - 1));
    if (new Set(seeds).size !== seeds.length) throw new PlanError('seeds: a seed is listed twice');
  } else if (isObj(raw.seeds)) {
    only(raw.seeds, 'seeds', ['count', 'base']);
    const count = wholeNumber(raw.seeds.count, 'seeds.count', 1, 100_000);
    const base =
      raw.seeds.base === undefined ? 1 : wholeNumber(raw.seeds.base, 'seeds.base', 0, 2 ** 31 - 1);
    if (base + count - 1 > 2 ** 31 - 1) throw new PlanError('seeds: the last seed is too large');
    seeds = { count, base };
  } else throw new PlanError('seeds: a list such as [1, 2, 3] or { "count": 10, "base": 1 }');

  if (raw.swapSides !== undefined && typeof raw.swapSides !== 'boolean')
    throw new PlanError('swapSides: true or false');
  const ai = conditions.some((c) => usesAi(c.subject) || usesAi(c.opponent));
  if (ai && raw.spendCapUsd === undefined)
    throw new PlanError(
      'spendCapUsd: a cap in USD is needed when a condition uses an AI layer (null for none)'
    );
  if (raw.estimates !== undefined && !isObj(raw.estimates))
    throw new PlanError('estimates: an object is needed');
  if (raw.estimates)
    only(raw.estimates, 'estimates', [
      'llmRequestUsd',
      'tacticalRequestUsd',
      'llmAnswerSeconds',
      'tacticalAnswerSeconds',
    ]);
  const est = (raw.estimates ?? {}) as Obj;
  const estimates: Estimates = {};
  for (const k of [
    'llmRequestUsd',
    'tacticalRequestUsd',
    'llmAnswerSeconds',
    'tacticalAnswerSeconds',
  ] as const)
    if (est[k] !== undefined) estimates[k] = positive(est[k], `estimates.${k}`);

  if (raw.out !== undefined && (typeof raw.out !== 'string' || !raw.out))
    throw new PlanError('out: a folder is needed');
  return {
    name: raw.name,
    ...(raw.aiServer !== undefined ? { aiServer: raw.aiServer as string } : {}),
    conditions,
    objectives,
    maps,
    soldiers:
      raw.soldiers === undefined
        ? DEFAULT_SOLDIERS
        : wholeNumber(raw.soldiers, 'soldiers', 0, 2000),
    terrain: raw.terrain === undefined ? 'normal' : oneOf(raw.terrain, 'terrain', TERRAINS),
    timing,
    seeds,
    swapSides: raw.swapSides ?? true,
    stopAtSeconds:
      raw.stopAtSeconds === undefined || raw.stopAtSeconds === null
        ? null
        : wholeNumber(raw.stopAtSeconds, 'stopAtSeconds', 1, 100_000),
    parallel: raw.parallel === undefined ? 1 : wholeNumber(raw.parallel, 'parallel', 1, 64),
    spendCapUsd:
      raw.spendCapUsd === undefined || raw.spendCapUsd === null
        ? null
        : positive(raw.spendCapUsd, 'spendCapUsd'),
    maxMatches:
      raw.maxMatches === undefined || raw.maxMatches === null
        ? null
        : wholeNumber(raw.maxMatches, 'maxMatches', 1, 10_000_000),
    ...(raw.out !== undefined ? { out: raw.out as string } : {}),
    estimates,
  };
}

// The AI server's origin, on this computer only: the runner sends no AI password, and the access
// guard (server/aiAccess.ts) lets only requests from this computer through without one
export function aiServerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlanError(`aiServer: "${value}" is not an address`);
  }
  const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !loopback)
    throw new PlanError(
      `aiServer: an AI server on this computer is needed (http://127.0.0.1:<port>: npm run dev or the AI bridge), not ${url.origin}`
    );
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== ''))
    throw new PlanError(
      'aiServer: the server\'s address alone is needed ("http://127.0.0.1:5173")'
    );
  return url.origin;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function seedList(seeds: Plan['seeds']): number[] {
  if (Array.isArray(seeds)) return seeds;
  return Array.from({ length: seeds.count }, (_, i) => (seeds.base ?? 1) + i);
}

// A saved map's text and label, from its file
function savedMap(spec: { saved: string; name?: string }, planDir: string): [string, string] {
  const file = isAbsolute(spec.saved) ? spec.saved : resolve(planDir, spec.saved);
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch (err) {
    throw new PlanError(`maps: cannot read ${file} (${(err as Error).message})`);
  }
  let grid = text;
  let name = spec.name ?? file.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
  if (text.startsWith('{')) {
    let all: unknown;
    try {
      all = JSON.parse(text);
    } catch {
      throw new PlanError(`maps: ${file} is not a saved map nor JSON`);
    }
    if (!isObj(all) || spec.name === undefined || !Object.hasOwn(all, spec.name))
      throw new PlanError(`maps: ${file} holds saved maps; name one of them with "name"`);
    grid = String(all[spec.name]);
    name = spec.name;
  }
  const decoded = decodeGrid(grid);
  if (!decoded) throw new PlanError(`maps: ${file} does not hold a readable map`);
  return [encodeGrid(decoded), `saved: ${name}`];
}

// The repository's root folder (this file is experiments/plan.ts, or bundled into
// dist-experiments/)
export const REPO_ROOT = findRoot();

// The folder above this file's (experiments/ or dist-experiments/) when it holds the repository,
// else the working folder (npm runs scripts from the repository's root)
function findRoot(): string {
  const above = resolve(fileURLToPath(new URL('..', import.meta.url)));
  return existsSync(resolve(above, 'experiments', 'plan.ts')) ? above : process.cwd();
}

export interface Overrides {
  out?: string; // --out
  aiServer?: string; // --ai-server
  maxMatches?: number; // --max-matches
}

// Plan order: seed, objective, map, condition, then the subject as West and (swapSides) as
// East. A run stopped part-way (the spend cap, Ctrl+C, maxMatches) leaves every condition with
// about as many matches, and a seed's mirrored pair is played one after the other.
export function expandPlan(plan: Plan, file: string, overrides: Overrides = {}): ExpandedPlan {
  const planDir = dirname(file);
  const maps = plan.maps.map((m): [string, string | null] => {
    if (m === 'random') return ['random', null];
    if (m === 'fixed') {
      const grid = decodeGrid(FIXED_MAP);
      if (!grid) throw new PlanError('the fixed map cannot be read');
      return ['fixed', encodeGrid(grid)];
    }
    const [grid, label] = savedMap(m, planDir);
    return [label, grid];
  });
  const labels = new Set<string>();
  for (const [label, grid] of maps) {
    const id = label === 'random' ? 'random' : sha256(grid!);
    if (labels.has(id)) throw new PlanError(`maps: ${label} is listed twice`);
    labels.add(id);
  }
  const mapSlugs = new Set(maps.map(([label]) => slug(label)));
  if (mapSlugs.size !== maps.length)
    throw new PlanError('maps: two saved maps have the same name; give them different names');

  const matches: MatchDef[] = [];
  for (const seed of seedList(plan.seeds))
    for (const objective of plan.objectives)
      for (const [map, mapGrid] of maps)
        for (const c of plan.conditions)
          for (const subjectSide of plan.swapSides
            ? (['west', 'east'] as const)
            : (['west'] as const)) {
            const west = subjectSide === 'west' ? c.subject : c.opponent;
            const east = subjectSide === 'west' ? c.opponent : c.subject;
            const def = {
              condition: c.name,
              objective,
              map,
              mapHash: mapGrid === null ? null : sha256(mapGrid).slice(0, 16),
              seed,
              subjectSide,
              west,
              east,
              timing: c.timing ?? plan.timing,
              soldiers: plan.soldiers ?? DEFAULT_SOLDIERS,
              terrain: plan.terrain ?? 'normal',
              stopAtSeconds: plan.stopAtSeconds ?? null,
            };
            matches.push({
              ...def,
              index: matches.length,
              key: [slug(c.name), objective, slug(map), `s${seed}`, subjectSide].join('.'),
              hash: sha256(canonical(def)).slice(0, 12),
              mapGrid,
            });
          }
  const ai = plan.conditions.some((c) => usesAi(c.subject) || usesAi(c.opponent));
  const max = overrides.maxMatches ?? plan.maxMatches;
  const kept = max ? matches.slice(0, max) : matches;
  return {
    plan,
    file,
    hash: sha256(canonical(matches.map((m) => [m.key, m.hash]))).slice(0, 12),
    matches: kept,
    allMatches: matches.length,
    out: overrides.out
      ? resolve(overrides.out)
      : plan.out
        ? resolve(planDir, plan.out)
        : resolve(REPO_ROOT, 'experiments', 'results', plan.name),
    aiServer: ai ? aiServerOrigin(overrides.aiServer ?? plan.aiServer ?? DEFAULT_AI_SERVER) : null,
  };
}

export function readPlan(file: string, overrides: Overrides = {}): ExpandedPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new PlanError(`cannot read the plan ${file}: ${(err as Error).message}`);
  }
  return expandPlan(checkPlan(raw), resolve(file), overrides);
}
