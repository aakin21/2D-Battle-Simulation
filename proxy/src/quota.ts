// The quota (the author's decision, 2026-11-22): each visitor, told apart by the address its
// requests come from (an IPv6 address by its /64, client.ts), may play MATCHES_PER_DAY matches a
// UTC day with the tactical layer (Jev or Snap). A match is the page's match id (x-match-id): the
// first MATCHES_PER_DAY distinct ids of a day are accepted, a request with another is refused.
// An accepted id stays usable for MATCH_WINDOW_MS after its first request and for
// MATCH_MAX_REQUESTS requests, so one id is never an endless pass. One visitor using up their
// matches changes nothing for anyone else: each address has its own counter, a Durable Object
// (index.ts) that keeps this state and nothing else, and deletes it once the day and the window of
// its last match are over.

// The default; the Worker's MATCHES_PER_DAY var overrides it (handler.ts)
export const DEFAULT_MATCHES_PER_DAY = 2;

// How long a match id is usable after its first request. A battle lasts at most 500 s of game time
// (MATCH_TIME_LIMIT; 480 s in control mode), about 8 minutes in real-time AI timing. In paused AI
// timing the battle waits for every AI answer: the LLM reports every 15 s of game time, about 34
// times per side, and a slow model on the player's own computer may take up to the server's
// 110 s for one, so a paused match can last over an hour (34 × 110 s ≈ 62 min, plus the battle and
// the player's own pauses). Two hours keeps such a match whole; what one id may cost is bounded by
// MATCH_MAX_REQUESTS, not by the window.
export const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

// Requests one match id may make. The tactical layer asks every 4 s of game time per side
// (JEV_INTERVAL_SEC): 125 requests per side in a 500 s battle, 250 with both sides on it, the
// same in paused AI timing (the interval is game time). The page retries a failed request at most
// twice within it, and three failures in a row stop the layer, so 400 leaves room for retries
// without letting an id run on.
export const MATCH_MAX_REQUESTS = 400;

// The one storage key: the visitor's matches
const STATE_KEY = 'matches';
const DAY_MS = 24 * 60 * 60 * 1000;

// What the page is told about a visitor's quota
export interface QuotaView {
  matchesPerDay: number;
  matchesUsed: number; // matches begun today (UTC)
  matchesLeft: number; // new matches still possible today; a match already begun goes on
  resetsAt: string; // the next 00:00 UTC, ISO 8601
}

// Why a request is refused
export type Refusal =
  | 'matches-used' // a new match id when today's matches are used
  | 'match-window' // the match id's MATCH_WINDOW_MS is over
  | 'match-requests'; // the match id has made MATCH_MAX_REQUESTS requests

export type TakeResult =
  | { ok: true; quota: QuotaView; newMatch: boolean }
  | { ok: false; reason: Refusal; quota: QuotaView };

// The counter's methods as the Worker calls them (Durable Object RPC, index.ts)
export interface QuotaStub {
  take(matchId: string, now: number, matchesPerDay: number): Promise<TakeResult>;
  peek(now: number, matchesPerDay: number): Promise<QuotaView>;
}

// The part of a Durable Object's storage the counter uses (ctx.storage has it; tests fake it)
export interface QuotaStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
}

// What a Durable Object gets (DurableObjectState, the part used here)
export interface DurableObjectStateLike {
  storage: QuotaStorage;
}

// One match of the visitor: its id, the UTC day of its first request (the day it counts for),
// that request's time and how many requests it has made
interface Match {
  id: string;
  day: string;
  first: number;
  requests: number;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// The end of a UTC day (the next day's 00:00 UTC), in ms
function dayEnd(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) + DAY_MS;
}

export function resetsAt(now: number): string {
  return new Date(dayEnd(utcDay(now))).toISOString();
}

// A match is kept while it counts for today, or while its id is still usable (a match begun
// before midnight goes on after it, without counting for the new day)
function kept(match: Match, now: number): boolean {
  return match.day >= utcDay(now) || now < match.first + MATCH_WINDOW_MS;
}

// When nothing of `matches` is needed any more
function expiry(matches: Match[]): number {
  return Math.max(...matches.map((m) => Math.max(dayEnd(m.day), m.first + MATCH_WINDOW_MS)));
}

function isMatch(value: unknown): value is Match {
  const m = value as Partial<Match> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof m.id === 'string' &&
    typeof m.day === 'string' &&
    typeof m.first === 'number' &&
    typeof m.requests === 'number'
  );
}

function view(matches: Match[], now: number, matchesPerDay: number): QuotaView {
  const today = utcDay(now);
  const used = matches.filter((m) => m.day === today).length;
  return {
    matchesPerDay,
    matchesUsed: used,
    matchesLeft: Math.max(0, matchesPerDay - used),
    resetsAt: resetsAt(now),
  };
}

// One visitor's matches in a Durable Object's storage. Every call runs alone, in the order called
// (`serial`): a Durable Object already holds other requests while its storage is read or written
// (input gates), and the queue keeps that true for the read, the decision and the write together,
// so two requests of a new match at once count one match.
export class QuotaBook {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: QuotaStorage) {}

  // Counts one request of `matchId`, or refuses it; refused requests write nothing
  take(matchId: string, now: number, matchesPerDay: number): Promise<TakeResult> {
    return this.serial(async () => {
      const matches = await this.load(now);
      const match = matches.find((m) => m.id === matchId);
      if (match) {
        if (now >= match.first + MATCH_WINDOW_MS)
          return { ok: false, reason: 'match-window', quota: view(matches, now, matchesPerDay) };
        if (match.requests >= MATCH_MAX_REQUESTS)
          return { ok: false, reason: 'match-requests', quota: view(matches, now, matchesPerDay) };
        match.requests++;
        await this.storage.put(STATE_KEY, matches);
        return { ok: true, newMatch: false, quota: view(matches, now, matchesPerDay) };
      }
      if (view(matches, now, matchesPerDay).matchesLeft <= 0)
        return { ok: false, reason: 'matches-used', quota: view(matches, now, matchesPerDay) };
      matches.push({ id: matchId, day: utcDay(now), first: now, requests: 1 });
      await this.storage.put(STATE_KEY, matches);
      // Deleted when the day and this match's window are over (alarm → expire)
      await this.storage.setAlarm(expiry(matches));
      return { ok: true, newMatch: true, quota: view(matches, now, matchesPerDay) };
    });
  }

  // The visitor's quota, without counting anything
  peek(now: number, matchesPerDay: number): Promise<QuotaView> {
    return this.serial(async () => view(await this.load(now), now, matchesPerDay));
  }

  // The alarm: what is no longer needed goes; with nothing left, the object's storage is deleted
  // (its alarm too, compatibility date 2026-02-24 or later)
  expire(now: number): Promise<void> {
    return this.serial(async () => {
      const matches = await this.load(now);
      if (matches.length === 0) {
        await this.storage.deleteAll();
        return;
      }
      await this.storage.put(STATE_KEY, matches);
      await this.storage.setAlarm(expiry(matches));
    });
  }

  // The stored matches that are still needed (damaged entries dropped)
  private async load(now: number): Promise<Match[]> {
    const stored = await this.storage.get<unknown>(STATE_KEY);
    return Array.isArray(stored) ? stored.filter(isMatch).filter((m) => kept(m, now)) : [];
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
