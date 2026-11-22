// The tactical proxy, a Cloudflare Worker (README.md): the module Worker's fetch handler
// (handler.ts) and the Durable Object class that counts one visitor's matches (quota.ts).

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { createHandler } from './handler';
import { QuotaBook, type DurableObjectStateLike, type QuotaView, type TakeResult } from './quota';

export default createHandler();

// One per visitor's address (named by its salted hash, client.ts), SQLite-backed (the Free plan's
// only kind). The Worker calls its methods over RPC; the alarm deletes what is no longer needed.
export class QuotaCounter extends DurableObject<Env> {
  private readonly book: QuotaBook;

  constructor(ctx: DurableObjectStateLike, env: Env) {
    super(ctx, env);
    this.book = new QuotaBook(ctx.storage);
  }

  take(matchId: string, now: number, matchesPerDay: number): Promise<TakeResult> {
    return this.book.take(matchId, now, matchesPerDay);
  }

  peek(now: number, matchesPerDay: number): Promise<QuotaView> {
    return this.book.peek(now, matchesPerDay);
  }

  async alarm(): Promise<void> {
    await this.book.expire(Date.now());
  }
}
