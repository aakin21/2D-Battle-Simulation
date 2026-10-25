import { StateManager } from '../state/StateManager';
import { sectorTarget } from '../engine/Sectors';
import { enemyBase } from '../engine/Objectives';
import { MAX_LLM_VIA } from '../engine/Rules';
import { FALLBACK_ORDERS, HeroCommand, IHero, OrderFallback, Position } from '../types/types';
import type { LlmDecision, LlmUsage } from './types';

// Reading the LLM's answer: its free-form reply is validated before anything is used (hero
// exists, place valid, target alive); what cannot be used is rejected with a reason, never
// guessed. Also what the answer cost, as the dev server reports it.

const MAX_REASON = 300; // characters of an order's reason that are kept
const MAX_FALLBACK_WHEN = 200; // characters of a fallback's condition that are kept

interface RawOrder {
  reason?: unknown;
  hero?: unknown;
  command?: unknown;
  place?: unknown;
  sector?: unknown;
  via?: unknown;
  fallback?: unknown;
  target_hero?: unknown;
}

export function usageOf(body: Record<string, unknown> | null): LlmUsage | null {
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

// Reads the reply's JSON into the decision (situation, change, stance, plan) and returns its
// orders, still unchecked; null, with the reason in `rejected`, when there is no orders list.
export function readReply(text: string, d: LlmDecision): unknown[] | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    d.rejected.push('reply was not valid JSON');
    return null;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  d.situation = str(parsed.situation);
  d.change = str(parsed.change);
  d.plan = str(parsed.plan);
  const stance = str(parsed.stance);
  if (stance === 'aggressive' || stance === 'defensive' || stance === 'regroup') d.stance = stance;
  else d.rejected.push(`unknown stance ${stance || '(none)'}`);

  if (!Array.isArray(parsed.orders)) {
    d.rejected.push('no "orders" list');
    return null;
  }
  return parsed.orders as unknown[];
}

// One entry of the reply's orders as a command for one of `heroes` (this side's, alive), with
// its reason, or why it cannot be used. One malformed entry must not stop the layer.
export function readOrder(
  sm: StateManager,
  heroes: IHero[],
  entry: unknown
): { hero: IHero; command: HeroCommand; reason: string } | string {
  if (!entry || typeof entry !== 'object')
    return `order is not an object: ${JSON.stringify(entry)}`;
  const raw = entry as RawOrder;
  const index = heroNumber(raw.hero);
  const hero = heroes.find((h) => h.heroIndex === index);
  if (!hero) return `unknown or dead hero ${String(raw.hero)}`;
  const parsed = toCommand(sm, hero, raw);
  if (typeof parsed === 'string') return `hero ${hero.heroIndex}: ${parsed}`;
  // The order's reason travels with it: Jev reads it, the panel and the log show it
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, MAX_REASON) : '';
  // D60: so does its fallback, a hint for the tactical layer; a bad one refuses the order
  const fallback = readFallback(raw.fallback);
  if (typeof fallback === 'string') return `hero ${hero.heroIndex}: ${fallback}`;
  const command: HeroCommand = { ...parsed };
  if (reason) command.reason = reason;
  if (fallback) command.fallback = fallback;
  return { hero, command, reason };
}

// A hero's number as the LLM writes it: an integer, or a string of digits ("2", " 2 "); anything
// else (true, [1], "0x1", "1e0", "1.0") is no hero, not coerced into one
function heroNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

// An order's fallback: {"when": "<condition>", "do": "retreat|regroup|hold"}; null when none is
// given, the reason when it cannot be used
function readFallback(raw: unknown): OrderFallback | null | string {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return `invalid fallback ${String(raw)}`;
  const f = raw as { when?: unknown; do?: unknown };
  const when = typeof f.when === 'string' ? f.when.trim().slice(0, MAX_FALLBACK_WHEN) : '';
  const order = typeof f.do === 'string' ? f.do.trim().toLowerCase() : '';
  if (!when) return 'fallback without a "when"';
  const known = FALLBACK_ORDERS.find((o) => o === order);
  if (!known)
    return `fallback "do" must be one of ${FALLBACK_ORDERS.join(', ')} (got ${String(f.do)})`;
  return { when, do: known };
}

// A place the LLM names: "A", or "point A" as the report names it (way_to_objectives), or a
// sector or sub-sector ("D4", "D4-NE"); null when it is none of these
function placeTarget(sm: StateManager, place: unknown): Position | null {
  if (typeof place !== 'string') return null;
  const pointName = place
    .trim()
    .toUpperCase()
    .replace(/^POINT\s+/, '');
  const point = sm.getBattlefield().objective.points.find((p) => p.name === pointName);
  return point ? point.position : sectorTarget(place);
}

// Returns a command, or a reason why the order cannot be used.
function toCommand(sm: StateManager, hero: IHero, raw: RawOrder): HeroCommand | string {
  // Written by the model: case and outer spaces do not matter ("Move", " regroup ")
  const command = typeof raw.command === 'string' ? raw.command.trim().toLowerCase() : raw.command;
  switch (command) {
    case 'move': {
      const place = typeof raw.place === 'string' ? raw.place : raw.sector;
      const target = placeTarget(sm, place);
      if (!target) return `invalid place ${String(place)}`;
      // D60: places walked to first, in order; one bad place refuses the order (never guessed)
      if (raw.via === undefined || raw.via === null) return { type: 'move', target };
      const list = typeof raw.via === 'string' ? [raw.via] : raw.via;
      if (!Array.isArray(list)) return `invalid via ${String(raw.via)}`;
      if (list.length > MAX_LLM_VIA)
        return `at most ${MAX_LLM_VIA} via places (${list.length} given)`;
      const via: Position[] = [];
      for (const v of list) {
        const p = placeTarget(sm, v);
        if (!p) return `invalid via place ${String(v)}`;
        via.push(p);
      }
      return via.length ? { type: 'move', target, via } : { type: 'move', target };
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
    case 'lead':
      return { type: 'lead' };
    case 'regroup':
      return { type: 'regroup' };
    case 'attack_base':
      return enemyBase(sm, hero.faction)
        ? { type: 'attackBase' }
        : 'there is no enemy base in this mode';
    case 'attack_hero': {
      const index = heroNumber(raw.target_hero);
      const alive = sm
        .getHeroes()
        .some((h) => h.faction !== hero.faction && h.heroIndex === index && h.hp > 0);
      return alive && index !== null
        ? { type: 'attackHero', heroIndex: index }
        : `enemy hero ${String(raw.target_hero)} does not exist or is dead`;
    }
    default:
      return `unknown command ${String(raw.command)}`;
  }
}
