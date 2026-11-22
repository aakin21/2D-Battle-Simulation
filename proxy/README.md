# Tactical proxy (Cloudflare Worker)

The published demo is a static site (GitHub Pages). A visitor's LLM runs on their own account or computer, but the tactical layer's models, Jev (TypeSafe) and SubQ Snap, run on the author's keys, which cannot be given out (D7). This Worker holds the two keys and forwards the page's tactical requests, within a quota: **each visitor, told apart by their IP address, may play 2 matches a UTC day with Jev or Snap.** One visitor using up their matches changes nothing for anyone else.

| Endpoint | What |
|---|---|
| `POST /api/jev` | Forwarded to `https://api.typesafe.ai/v1/systemone` with `TYPESAFE_API_KEY` |
| `POST /api/snap` | Forwarded to `https://api.subq.ai/v1/systemone` with `SUBQ_API_KEY` |
| `GET /api/tactical` | Which models it serves and the caller's quota, before a match; counts nothing |

The same hygiene as the dev server's proxies (`vite.config.ts`): POST only, at most `JEV_MAX_REQUEST_SIZE` (100,000) characters of body (imported from `src/ai/Limits.ts`, not copied), only `Content-Type` and `Accept` passed on plus the key, none of the service's `Set-Cookie`, `Access-Control-*`, `Location`, `Vary` or other headers passed back (only `Content-Type`, `Retry-After`, `retry-after-ms`), a redirect from the service answered with 502 and never followed, a service silent for `JEV_PROXY_TIMEOUT_MS` (14 s, also imported) answered with 504. No key in any answer or log.

## What it is not

- **Not authentication.** Pages on other websites are refused by their `Origin` header (a browser sends it and a page cannot change it), but any program can send any `Origin`: the check keeps other sites' pages out, nothing more.
- **Not exact per person.** The quota counts addresses: an IPv4 address whole, an IPv6 address by its /64. Visitors behind one address (a school, an office, a mobile carrier's shared address) share its 2 matches; one person can get more by changing address (a VPN, another network, another /64 of their IPv6 range).
- **Not the spending cap.** The real cap is the prepaid balance of the TypeSafe and SubQ accounts ($5 each). **Check that auto-recharge (automatic top-up) is off in both dashboards.** When a balance runs out, the service refuses and the proxy passes its error on.

What one address can use at most: 2 matches a day × 400 requests per match (a match id is also usable for 2 hours only) = 800 requests a day.

## Why a Durable Object, and the Free plan

Cloudflare's Free plan, read on 2026-11-22 (developers.cloudflare.com: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), page dated 2026-11-19; [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), 2026-11-13; [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), 2026-10-30; [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), 2026-11-12):

| Service | Free plan |
|---|---|
| Workers | 100,000 requests a day, 10 ms CPU per request |
| Durable Objects (SQLite-backed only on Free) | 100,000 requests, 13,000 GB-s, 5 million rows read, 100,000 rows written a day, 5 GB stored |
| Workers KV | 100,000 reads, 1,000 writes a day |
| Rate Limiting binding | counts per Cloudflare location, eventually consistent ("each check uses a local count"); not one worldwide limit |

Every limit resets at 00:00 UTC; past one, further operations fail (the Worker answers Cloudflare's error 1027); nothing is charged on the Free plan. KV's 1,000 writes a day would last about four matches if every request wrote a count, and the Rate Limiting binding cannot count a day nor count exactly. So each address has its own Durable Object (`QuotaCounter`, SQLite-backed), which counts exactly: one object handles its requests one at a time.

One tactical request costs one Worker request, one Durable Object request and one row written; a refused request writes nothing. A match with both sides on the tactical layer makes about 250 requests (one every 4 s of game time per side, 500 s), so the free limits allow about 400 such matches a day (800 with one side on it); the prepaid balances will likely run out first.

What is stored, per address: an object named by HMAC-SHA-256 of the address with the secret `QUOTA_SALT` (the address itself is never stored), holding the page's match ids of the day (and of a match still running from the day before), each with its day, the time of its first request and its number of requests. The object's alarm deletes it all once the day and the 2-hour window of its last match are over. No address, no `Origin`, no request body. Workers Logs are off (`observability.enabled: false` in `wrangler.jsonc`); the proxy logs only failures, without addresses or keys. Cloudflare itself sees visitors' addresses, as it carries the traffic. Without `QUOTA_SALT` the proxy refuses visitors (503) rather than count unsalted addresses; the author's key still passes.

## Deploy (free)

You need Node (as for the rest of the repository). Nothing here creates anything until you run these commands.

1. Create a Cloudflare account: <https://dash.cloudflare.com/sign-up>, confirm the email. The Free plan needs no payment method.
2. In a terminal, in the repository: `cd proxy`
3. `npx wrangler login` (npx asks once to download Wrangler; the browser asks you to allow it).
4. `npx wrangler deploy`. The first time, Wrangler may ask you to choose a `workers.dev` subdomain (it becomes part of the address). This creates the Worker and its Durable Object storage (the `exports` entry in `wrangler.jsonc`); there is nothing to create by hand. At the end it prints the address: `https://battle-tactical-proxy.<your subdomain>.workers.dev`. Until the secrets are set, every tactical request is refused (503), which is safe.
5. The secrets (each command asks for the value and deploys at once):
   - `npx wrangler secret put QUOTA_SALT`: a long random value, e.g. the output of `openssl rand -base64 32`. Keep it secret.
   - `npx wrangler secret put TYPESAFE_API_KEY`: the Jev key.
   - `npx wrangler secret put SUBQ_API_KEY`: the Snap key.
   - `npx wrangler secret put AUTHOR_KEY`: another `openssl rand -base64 32` value. Requests carrying it in `x-ai-key` are not counted (your own demos, a lecture hall behind one address). Optional: without it there is no exemption.
   - `npx wrangler secret list` shows the names (never the values).
6. Check it: `curl -s -H 'Origin: https://aakin21.github.io' https://battle-tactical-proxy.<your subdomain>.workers.dev/api/tactical` answers `{"jev":true,"snap":true,"quota":{"matchesPerDay":2,"matchesUsed":0,"matchesLeft":2,"resetsAt":"…"}}` (counts nothing); without the `-H` it answers 403.
7. Give that address to the page (the tactical layer's address when the page has no AI server of its own).

If Wrangler refuses the `exports` entry (an older Wrangler), replace it in `wrangler.jsonc` with the older form, `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["QuotaCounter"] }]`. Cloudflare's documentation calls `migrations` legacy; the two cannot be mixed, and a Worker deployed with `exports` cannot go back.

## Settings

- **The quota**: `MATCHES_PER_DAY` in `wrangler.jsonc` (a whole number, 0 to 1000; anything else means 2), then `npx wrangler deploy`. `0` turns visitors off; the author's key still works. The window of a match id (2 hours) and its request cap (400) are constants in `src/quota.ts` (`MATCH_WINDOW_MS`, `MATCH_MAX_REQUESTS`), with the reasoning.
- **Allowed sites**: `ALLOWED_ORIGINS` in `wrangler.jsonc`, comma-separated origins (scheme, host, port; no path). Add `http://localhost:5173` to try `npm run dev` against the deployed proxy. An entry that is not an origin (`*` included) is left out; none valid means every page is refused.
- **Reset every counter**: put a new `QUOTA_SALT`; every address gets a new counter, the old ones expire on their own.

## Usage

- Cloudflare dashboard → Workers & Pages → `battle-tactical-proxy` → Metrics: requests, errors, CPU time. The account's daily use against the free limits is on the Workers & Pages overview.
- The spending: TypeSafe's and SubQ's dashboards.
- Live: `npx wrangler tail` streams each request while it runs (on your screen only, with visitors' addresses; nothing is kept).
- There is no total of matches across visitors, by design; `GET /api/tactical` shows a caller their own numbers.

## Turn it off quickly

- One model: `npx wrangler secret delete TYPESAFE_API_KEY` (or `SUBQ_API_KEY`): that route answers 503 at once.
- Visitors only: `MATCHES_PER_DAY` to `"0"`, then `npx wrangler deploy`.
- Everything: dashboard → the Worker → Settings → Domains & Routes → turn off `workers.dev`; or `npx wrangler delete` (the Worker and its counters).
- Surest: revoke the keys in the TypeSafe and SubQ dashboards.

## What the page must handle

Requests: `POST /api/jev` or `/api/snap` with `Content-Type: application/json`, `x-match-id: <id>` (required; 8 to 64 letters, digits, `_` or `-`; one id per match, shared by both sides and both routes) and, for the author only, `x-ai-key: <AUTHOR_KEY>`. The browser sends a preflight first (answered for the allowed origins, cached 2 hours); the proxy allows exactly `Content-Type`, `Accept`, `x-match-id` and `x-ai-key`, so the page must not send `ngrok-skip-browser-warning` or other headers there.

| Answer | Meaning | The page |
|---|---|---|
| The service's status and JSON (200, or its 401, 422, 429, 529, …) | Forwarded; `x-tactical-matches-left: <n>` on a counted request | As today |
| 403 with `x-tactical-quota: matches-used`, `match-window` or `match-requests`; JSON `{ error, reason, quota: { matchesPerDay, matchesUsed, matchesLeft, resetsAt } }` | The quota: today's matches are used; this match id's 2 hours are over; or its 400 requests are | Stop the tactical layer at once (403 is never retried) and show `error`, not the dev server's key hint |
| 403 without `x-tactical-quota`, JSON `{ error }` | Not an allowed site, or no usable client address | Stop |
| 400 `{ error }` | `x-match-id` missing or malformed (a page bug) | Stop |
| 404, 405, 413 `{ error }` | Wrong path, wrong method, body over 100,000 characters | Stop |
| 502, 504 `{ error }` | The service unreachable or answered with a redirect; silent for 14 s | Retried as today |
| 503 `{ error, retryable: false }` | That model's key (or the salt) is not set | Stop |
| 503 `{ error, retryable: true }` | The match counter failed (also when a free Durable Object limit is used up); nothing was sent | Retried as today |
| Cloudflare's own error page (HTML), e.g. error 1027 | A free daily limit is used up, until 00:00 UTC | Shown as a failure |

`GET /api/tactical` (same `Origin` rule): `{ jev, snap, quota: { matchesPerDay, matchesUsed, matchesLeft, resetsAt } }`, plus `exempt: true` for the author's key. `matchesLeft: 0` means no new match today; a match already begun goes on. `jev`/`snap` are false when that key is not set, both false without the salt.

The page reads `Retry-After`, `retry-after-ms`, `x-tactical-quota` and `x-tactical-matches-left` across origins only because the proxy exposes them (`Access-Control-Expose-Headers`).

## Code and tests

| File | What |
|---|---|
| `src/index.ts` | The Worker's entry: the fetch handler and the Durable Object class `QuotaCounter` |
| `src/handler.ts` | Routes, origin and CORS, the checks, forwarding (`createHandler(options)`: the services' origins, the timeout and the clock can be given for tests) |
| `src/quota.ts` | The quota rule and its storage (`QuotaBook`), the constants |
| `src/client.ts` | The address's key (IPv6 by /64), the salted name, the constant-time comparison of the author's key |
| `src/env.ts` | The Worker's `env` |
| `src/cloudflare-workers.d.ts` | The part of `cloudflare:workers` used (no `@cloudflare/workers-types` needed) |
| `wrangler.jsonc` | Name, entry, vars, the Durable Object binding; no secrets |

Typecheck, lint and format are part of the repository's `npm run typecheck`, `npm run lint`, `npm run format:check` (`proxy/tsconfig.json`: Workers APIs, no Node types). The tests are outside the repository, `../tests/smoke/tacticalproxy.ts` (`./run-all.sh only tacticalproxy`): the handler in Node against fake services on 127.0.0.1 and a fake Durable Object storage; the real services are never called.

Not verified on Cloudflare: everything above runs only in Node with fakes. Not tried: a real deploy, the `exports` entry, Durable Object RPC and alarms on the real runtime, the CPU time per request, the real `CF-Connecting-IP`, the real TypeSafe and SubQ answers through the proxy.
