import { StateManager } from '../state/StateManager';
import { sectorTarget } from '../engine/Sectors';
import { enemyBase } from '../engine/Objectives';
import { HeroCommand, IHero } from '../types/types';
import type { LlmDecision, LlmUsage } from './LlmController';

// Reading the LLM's answer: its free-form reply is validated before anything is used (hero
// exists, place valid, target alive); what cannot be used is rejected with a reason, never
// guessed. Also what the answer cost, as the dev server reports it.

const MAX_REASON = 300; // characters of an order's reason that are kept

interface RawOrder {
  reason?: unknown;
  hero?: unknown;
  command?: unknown;
  place?: unknown;
  sector?: unknown;
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
  const hero = heroes.find((h) => h.heroIndex === Number(raw.hero));
  if (!hero) return `unknown or dead hero ${String(raw.hero)}`;
  const parsed = toCommand(sm, hero, raw);
  if (typeof parsed === 'string') return `hero ${hero.heroIndex}: ${parsed}`;
  // The order's reason travels with it: Jev reads it, the panel and the log show it
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, MAX_REASON) : '';
  return { hero, command: reason ? { ...parsed, reason } : parsed, reason };
}

// Returns a command, or a reason why the order cannot be used.
function toCommand(sm: StateManager, hero: IHero, raw: RawOrder): HeroCommand | string {
  // Written by the model: case and outer spaces do not matter ("Move", " regroup ")
  const command = typeof raw.command === 'string' ? raw.command.trim().toLowerCase() : raw.command;
  switch (command) {
    case 'move': {
      const place = typeof raw.place === 'string' ? raw.place : raw.sector;
      // "A", or "point A" as the report names it (way_to_objectives)
      const pointName =
        typeof place === 'string'
          ? place
              .trim()
              .toUpperCase()
              .replace(/^POINT\s+/, '')
          : '';
      const point = sm.getBattlefield().objective.points.find((p) => p.name === pointName);
      const target = point
        ? point.position
        : typeof place === 'string'
          ? sectorTarget(place)
          : null;
      return target ? { type: 'move', target } : `invalid place ${String(place)}`;
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
      const index = Number(raw.target_hero);
      const alive = sm
        .getHeroes()
        .some((h) => h.faction !== hero.faction && h.heroIndex === index && h.hp > 0);
      return alive
        ? { type: 'attackHero', heroIndex: index }
        : `enemy hero ${String(raw.target_hero)} does not exist or is dead`;
    }
    default:
      return `unknown command ${String(raw.command)}`;
  }
}
