import type { QuotaStub } from './quota';

// The Durable Object namespace as the Worker uses it: Cloudflare's DurableObjectNamespace, the
// part called here (tests pass a fake of the same shape)
export interface QuotaNamespace {
  idFromName(name: string): object;
  get(id: object): QuotaStub;
}

// What the Worker is given (wrangler.jsonc, and the secrets set with `npx wrangler secret put`)
export interface Env {
  // Secrets, never in wrangler.jsonc. A missing provider key turns its route off (503).
  TYPESAFE_API_KEY?: string; // Jev, /api/jev
  SUBQ_API_KEY?: string; // SubQ Snap, /api/snap
  QUOTA_SALT?: string; // the HMAC key that names a visitor's counter; unset: visitors are refused
  AUTHOR_KEY?: string; // x-ai-key with this value is not counted; unset: no exemption
  // Vars (wrangler.jsonc)
  ALLOWED_ORIGINS?: string; // comma-separated origins; unset or blank: https://aakin21.github.io
  MATCHES_PER_DAY?: string; // a whole number 0–1000; unset or not a number: 2
  // One counter per visitor (a SQLite-backed Durable Object, class QuotaCounter)
  QUOTA: QuotaNamespace;
}
