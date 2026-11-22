# Experiments: matches without a browser

`experiments/` plays many matches headless in Node and writes results that can be analysed (Q11).
A match is played by the real engine (`SimulationEngine.step()`, the fixed 1/60 s step, D65) with
the real AI layers (`LlmController`, `JevController`), which send their requests over HTTP to an AI
server exactly as the browser sends them (`/api/llm`, `/api/jev`, `/api/snap`): the author's
`npm run dev`, or the AI bridge for LLM-only plans. Each match is written as the browser's match
log (`src/ui/MatchLog.ts`) with a block saying how to repeat it.

| File | What it is |
|---|---|
| `run.ts` | The runner: reads a plan, checks the AI server, plays the matches (several at once), writes the files, stops cleanly, resumes |
| `match.ts` | One match, in a worker thread of its own |
| `analyse.ts` | The analysis of a results folder: `report.md` and CSV files |
| `plan.ts` | The plan's schema (every field documented), its check and its expansion into matches |
| `results.ts` | Reading and writing a results folder, the summary row, the outcome hash |
| `stats.ts` | Mean, SD, median, p90, the Wilson and Newcombe intervals |
| `node.ts` | Node's own `localStorage` switched off before any browser module loads |
| `plan.example.json` | A plan with every field |
| `plans/pilot.json` | The first pilot (below) |

Built with esbuild into `dist-experiments/` (as the AI bridge is built), checked by `npm run
typecheck`, `npm run lint` and `npm run format:check`. No new dependency. Results go to
`experiments/results/` by default, which git ignores.

## A pilot, step by step

1. Start the AI server in a terminal: `npm run dev` (`.env.local` with `TYPESAFE_API_KEY` for Jev;
   Sonnet runs on the Claude login, as in the browser). Leave it running, and do not play LLM matches
   in the browser meanwhile: the server keeps one LLM session per side (below).
2. See what would be played, with estimates, without playing anything:
   `npm run experiment -- experiments/plans/pilot.json --dry-run`
3. Optionally a first short trial, the first 4 matches only (the 2 rules matches, then Sonnet against
   the rules, both sides): `npm run experiment -- experiments/plans/pilot.json --max-matches 4`
4. The pilot: `npm run experiment -- experiments/plans/pilot.json`
   (the dev server on another port: add `--ai-server http://127.0.0.1:5174`). Ctrl+C once lets the
   running matches finish; twice abandons them. The same command later goes on where it stopped.
5. The analysis: `npm run experiment:analyse -- experiments/results/pilot`, then read
   `experiments/results/pilot/analysis/report.md`.

### The pilot plan and its estimates

`plans/pilot.json`: four conditions, each played on the control objective (D30, 480 s) on the fixed
map (D5) with 150 soldiers per side, seeds 1–3, sides swapped, paused AI timing (D4), two matches at
once, a spend cap of $25.

| Condition | Subject | Opponent |
|---|---|---|
| rules vs rules | rules | rules (the baseline: no AI request) |
| sonnet vs rules | LLM (Sonnet) | rules |
| sonnet+jev vs rules | LLM (Sonnet) + Jev | rules |
| sonnet+jev vs sonnet | LLM (Sonnet) + Jev | LLM (Sonnet) |

Estimates (upper bounds: every match to its time limit; all are estimates, none measured with the
real services by this tool):

- **Matches:** 24 (4 conditions × 3 seeds × 2 side assignments); 6 need no AI server.
- **Requests:** 768 LLM (32 per LLM side per 480 s match, every 15 s, D50) and 1,440 Jev (120 per
  Jev side, every 4 s).
- **Time:** about 37 min at two matches at once, 55 min one after another (`--dry-run`), with
  Sonnet's answers at about 4 s (D50: 3.3–3.9 s mean through the Agent SDK) and Jev's at 0.55 s
  (R14, median); a rules match takes seconds.
- **Cost:** R20 measured $0.87 per LLM side per 5-minute match for Sonnet through the Agent SDK at
  API prices (the author pays through his subscription; the SDK reports the estimate), $0.0435 per
  report at 20 reports. At that rate a 480 s match (32 reports) is $1.39 per LLM side and the pilot
  $33 (`--dry-run` says $33.42). The context grows over a match (Q16: 8.5k to 171k tokens over 16
  reports), so later reports cost more: if the cost per report grows in step with the report count,
  a 480 s match is about $0.87 × (32/20)² = $2.2 per LLM side and the pilot about $53. Jev and Snap:
  about $0.20 per 300 to 400 matches (R20), well under a cent for the pilot.
- **The cap:** $25 of reported cost will most likely stop the pilot during seed 2 (one seed is $11
  to $18 by the figures above). Matches are played seed by seed, so what is finished then covers
  every condition equally; raise `spendCapUsd` in the plan and run the same command to go on (the
  finished matches are kept). The dev server's own `LLM_MAX_BUDGET_USD` ($5 per LLM session, that
  is per side and match) is above one match's cost.

## How a match is played

- **A worker thread per match**, made fresh for each match as a fresh page would be. Its
  `Math.random` is its own, seeded from the match's seed with the smoke tests' generator
  (`tests/smoke/same.ts`), so matches played at once never draw from each other.
- **Set up as `UIController` sets up a run:** `applyConfig`, `restart`, then the AI layers as
  `startControllers` attaches them (per side: Jev or Snap, then the LLM), each with the AI server's
  address (`endpoint`) and a `fetchFn` of the runner (both options the layers already have). Nothing
  in `src/` was changed for the runner.
- **Rules on West:** the browser offers Rules only for East (West's "none" is the user). A West
  commanded by the rules has its heroes given to the rule layer before the first step, as a stopped
  AI layer gives them (`AiLayer.fail`) and as the title screen's recorded battle was made. The match
  log's settings then say `west: "none"`; its `experiment.sides` says `rules`.
- **Requests** go to the AI server only (any other address is refused and counted:
  `experiment.refusedRequests`). They carry what the browser sends from the dev server's own page:
  `Content-Type: application/json`, no AI password, no Origin (a program on this computer, which the
  access guard lets through).
- **Paused timing (D4):** the runner steps the engine and, whenever a layer waits
  (`isWaitingForAI()`), waits for the answer; no game time passes while waiting (each answer arrives
  one step after the step that sent it), so a match runs as fast as the answers come. One ordering
  rule, so that a match depends on the answers and not on which arrived first: when a side's Jev (or
  Snap) and its LLM asked in the same step (at 0 s, 60 s, 120 s, ...), the LLM's answer is applied
  after Jev's, as they asked, even when it arrives first (`experiment.answersHeld` counts these;
  the browser applies them as they arrive). Answers of the two sides commute (each touches only its
  own heroes).
- **Real-time timing (D4):** the engine's own fixed-step loop (`frame` → `advance`) runs on
  `requestAnimationFrame` given as a 60 Hz display gives it: a frame at each vsync, its timestamp
  the vsync's, late frames skipping vsyncs. At 1x that is 60 steps per real second, and an answer's
  latency costs the battle the wall time from the frame that sent the request to the answer, as in
  the browser (including the time the step took to build the request). **If the machine cannot keep
  up**, the engine does what it does in the browser: a frame counts at most 0.1 s, the time owed
  beyond is dropped, and the battle runs slower than real time, so answers then cost less game time
  than at a true 1x. Each match records it: `experiment.pacing` (`frames`, `skippedFrames`,
  `maxFrameGapMs`, `lagSeconds`: wall time minus game time, `fellBehind`: lag over 3 steps), and in
  the summary `realtime_lag_seconds` and `realtime_fell_behind`. Many paced matches at once on few
  cores make this likely.
- **A match with no AI layer** runs as fast as the machine goes in either timing: it waits for
  nothing, and the fixed step plays the same battle at any speed (D65).
- **`stopAtSeconds`** (a smoke run) stops each match at that simulation time; its result is
  "not finished".

Not built, an idea: a faster-than-real-time mode with scaled latency (the battle at k× speed, each
answer delayed by k× its latency in game time). It would make real-time experiments cheaper in wall
time, but the answer times themselves would still be real ones, so it is the same as real time only
if the latency does not depend on load; it is a third timing semantics the thesis has not defined.

## The plan

The schema is `plan.ts` (`Plan`), the example `plan.example.json`. Unknown fields are refused. A
relative path (`out`, a saved map) is taken from the plan file's folder.

| Field | Meaning |
|---|---|
| `name` | The plan's name; the default results folder is `experiments/results/<name>` |
| `aiServer` | Where the AI endpoints are, on this computer only: `http://127.0.0.1:5173` (default) for `npm run dev`, or the AI bridge's address (LLM only). `--ai-server` overrides it |
| `conditions` | A list of `{ name, subject, opponent, timing? }`; a side is `{ commander: "rules" \| "llm" \| "llm+jev" \| "llm+snap", model }` with the menu's model ids (`sonnet`, `openrouter:<id>`, `local:<name>`, ...). The subject is the side under study |
| `objectives` | `["control", "elimination", "base"]`, any of them |
| `maps` | `"random"` (made from each match's seed), `"fixed"`, or `{ "saved": "<file>" }`: a file with the text "Save this map" stores (it begins `v1;150;`), or the browser's saved maps (`localStorage.sim_maps`, e.g. copied from the console with `copy(localStorage.sim_maps)`) with `"name"` |
| `soldiers` | Soldiers per side (default 150); 3 heroes per side as in the menu |
| `terrain` | A random map's terrain: `light`, `normal` (default), `dense` |
| `timing` | `"paused"` or `"realtime"` (D4); a condition's own `timing` overrides it |
| `seeds` | A list, or `{ "count": n, "base": b }` (b, b+1, ...) |
| `swapSides` | Every match also with the sides swapped (default true) |
| `stopAtSeconds` | Stop each match at this simulation time (a smoke run), or null |
| `parallel` | Matches at once (default 1; `--parallel`) |
| `spendCapUsd` | The run stops when the answers' reported costs reach this; required when a condition uses an AI layer (null: none) |
| `maxMatches` | Only the plan's first n matches (`--max-matches`) |
| `out` | The results folder (`--out`) |
| `estimates` | For `--dry-run`: `llmRequestUsd`, `tacticalRequestUsd`, `llmAnswerSeconds`, `tacticalAnswerSeconds` |

**Plan order:** seed, objective, map, condition, then the subject as West and as East. A run that
stops part-way (the cap, Ctrl+C, `maxMatches`) leaves the conditions with about as many matches.

**A match's identity:** its key (`<condition>.<objective>.<map>.s<seed>.<subject side>`) and the
hash of everything that decides it (both sides, objective, map content, seed, soldiers, terrain,
timing, `stopAtSeconds`), in its file name `matches/<key>.<hash>.json`. A finished match is one
whose file is there; a started run skips it. Changing a match's settings gives it a new hash, so it
is played again (the old file stays and is left out of the summary); adding seeds or conditions, or
changing `parallel`, the cap, `maxMatches` or `out`, plays only what is new. The plan hash (of
every match's key and hash) is recorded for provenance.

**LLM sessions and `parallel`:** the AI server keeps one LLM session per side, `west` and `east`
(`server/llmEndpoint.ts`); two matches with an LLM on the same side at once would take the session
from each other at every request. The runner therefore never runs two matches with an LLM on the
same side at once: with the LLM on one side only, at most two such matches run together (the
subject as West in one, as East in the other); rules matches fill the other places.

## What the runner writes

```
<results folder>/
  matches/<key>.<hash>.json   one per finished match (written whole or not at all)
  summary.csv, summary.json   a row per match of the plan, in plan order (rebuilt from matches/)
  run.json                    the plan and its matches (the analysis reads it)
  sessions.jsonl              a line per invocation: code version, AI server status, how it ended
  abandoned.jsonl             matches abandoned (Ctrl+C twice, the cap) or failed, with their cost
  analysis/                   written by experiment:analyse
```

**A match file** is the browser's match log (`app`, `version` = `git describe`, `startedAt`,
`savedAt`, `settings`, `result`, `timeline` once per simulation second, `ai` with every decision and
every request and answer) with one more block, `experiment`: the plan (name, hash, file), the match
(key, hash, condition, subject side, objective, map and its hash, seed, timing, soldiers, terrain),
both sides, the code (`git describe`, commit, whether the tree had changes, the bundle's hash), the
Node version, the AI server's address and its `GET /api/bridge` status (which models it runs), the
start time and wall time, the steps, pacing, `answersHeld`, every request as the runner saw it
(`sentAt` and `arrivedAt` in simulation seconds, `wallMs`, in real time `sinceFrameMs`),
`refusedRequests`, `reportedCostUsd`, `finalStateHash` (the battlefield hash of `tests/smoke/same.ts`)
and `outcomeHash`.

An example from the test suite's runs (rules vs rules, 40 soldiers per side, control on the fixed
map, seed 3; shortened):

```json
"result": { "winner": "east", "reason": "points", "time": 480, "unitsLeftOnWinningSide": 35,
            "points": { "friendly": 0, "enemy": 511 } },
"experiment": {
  "match": { "key": "rules-vs-rules.control.fixed.s3.west", "hash": "6f8db5ad7f34", "seed": 3,
             "subjectSide": "west", "objective": "control", "map": "fixed", "timing": "paused", … },
  "pacing": { "mode": "no AI layer: as fast as the machine goes" },
  "steps": 28800, "wallSeconds": 1.564,
  "finalStateHash": "8adc126db7029487", "outcomeHash": "c4a03579ea96a811" }
```

and a request of an LLM + Jev side against the fake server in paused timing (each answered one step
after the step that sent it):

```json
"requests": [
  { "layer": "west.tactical", "seq": 1, "sentAt": 0, "arrivedAt": 0.0167, "wallMs": 27.9, "tries": 1, "held": false },
  { "layer": "west.llm", "seq": 2, "sentAt": 0, "arrivedAt": 0.0167, "wallMs": 24.3, "tries": 1, "held": false } ]
```

**The summary** (`summary.csv`, the same rows in `summary.json`) has a row per match: key, hashes,
condition, objective, map, seed, `subject_side`, timing, each side's commander and model; `status`
(`finished`, `not finished`, `error`), `winner_side`, `subject_result` (win, loss, draw),
`end_reason`, `game_seconds`; for `subject_` and `opponent_`: soldiers and heroes at the start and
lost, HP left, control points, base HP %; for each AI layer role (`subject_llm`,
`subject_tactical`, `opponent_llm`, `opponent_tactical`): model, requests, failed, skipped (Q7),
answer time mean / median / p90 (nearest rank) / max in ms over the answered requests, game latency
mean and max in s, input / output / cache-read / cache-write tokens, reported cost in USD (the LLM's
only), whether it stopped and why; then wall seconds, real-time lag and whether it fell behind,
answers held, refused requests, an error, the two hashes, the start time and the code version.

**Reproducibility.** The same plan with the same answers gives the same matches, byte for byte, but
for what measures time: the match files differ only in `startedAt`, `savedAt`, `version` (when the
code changed), every `latencyMs` and `apiMs`, the LLM's per-match `matchId` and the `experiment`
block; `outcomeHash` is the SHA-256 of the file without them. The summary's measured columns are
every `*_latency_*`, `wall_seconds`, `realtime_lag_seconds`, `realtime_fell_behind`, `answers_held`
and `started_at`; the rest is identical. Rules matches are reproducible outright (and equal to the
browser's battle with the same seed); paused matches given the same answers; real-time matches are
not (an answer's time decides when it is applied).

## Stopping, resuming, failing

- **Ctrl+C** once: no new match; the running ones finish and are written. Twice (or SIGTERM): they
  are abandoned at once; nothing is written for them (they are listed in `abandoned.jsonl` with what
  they cost so far) and the next run plays them from the start. A run killed outright leaves at most
  a `*.tmp` file, removed by the next run. Exit code 130.
- **The spend cap** counts the costs the answers report (the LLM's; Jev, Snap and local models report
  none) over every invocation in the folder: finished matches and abandoned ones. When it is reached,
  the running matches are abandoned at once and the run stops (exit code 3); a run started with the
  cap already reached plays nothing. An answer still on its way when a match is abandoned or ends is
  not counted (at most one per LLM side and match).
- **A layer that stops** (three failures in a row, a timeout, a refused key, a budget stop) stops as
  in the browser: the match goes on (its heroes under the rules, or the LLM alone when only the
  tactical layer stopped) and is recorded with why (`*_stopped`, `*_stop_reason`); it is not played
  again. When the reason will not pass by itself (a refused key, a model the server cannot run, a
  budget or plan limit: anything but failures in a row and timeouts), the run starts no new match
  (exit code 1): the next ones would only lose the same layer.
- **The AI server** is asked `GET /api/bridge` before the first match that needs it: no answer, a
  refusal, the AI bridge for a plan with Jev or Snap, or a model it says it cannot run: the run stops
  at once saying why (exit code 1). Whether the Jev and Snap keys work is not in the status: a refused
  key shows in the first match (above).
- `--dry-run` prints the matches, their count, the requests, the duration and (with `estimates`) the
  cost, and plays and writes nothing.

## The analysis

`npm run experiment:analyse -- <results folder>` writes `analysis/report.md` and CSV files:

- `conditions.csv` (and `cells.csv` per objective and map): matches, decided, wins / losses /
  draws of the subject, its win rate (wins over matches with a result; draws not won) with a 95%
  Wilson interval, not finished, errors, matches with a stopped layer, soldiers and heroes lost per
  side (mean, SD), match length (mean, SD, min, max).
- `sides.csv`: West wins, East wins, draws, West's share of the decisive battles with its interval:
  does a side win more with identical setups? A mirrored pair that is one battle (below) counts once.
- `pairs.csv`: the mirrored pairs (same condition, objective, map, seed): subject won both, lost
  both, West won both, East won both (the side decided, not the commander), with a draw, incomplete,
  and "same battle": both side assignments played the identical battle (the same outcome hash), as
  rules vs rules always does (the same commander on both sides and nothing random but the seed). Such
  a condition's win rate is 50% by construction; its side balance is what it measures.
- `layers.csv`: per condition and role: requests, failed, skipped, stopped, answer times pooled over
  every answer (mean, median, p90, max), game latency, tokens, cost in all and per match.
- `comparisons.csv`: conditions with the same opponent (e.g. Sonnet vs rules and Sonnet + Jev vs
  rules): the difference of win rates with Newcombe's hybrid score interval. It treats them as
  independent samples; they share seeds and maps, which it does not use.
- `missing.csv`: the planned matches with no file, so every pairing can be checked for both side
  assignments and every seed.

No plotting library; no new dependency.

## What the results can and cannot support

- **Can:** win rates and casualties of a condition against a baseline on the maps, objectives and
  seeds played, with their uncertainty; side balance; answer times, failures, skipped requests,
  tokens and reported cost per layer; paused against real-time timing for the same condition and
  seeds.
- **Cannot, or only with care:**
  - Real-time matches are not reproducible: answer times vary, and with them when orders take effect.
    Their results are samples of the AI's answers and of the machine's load (check
    `realtime_fell_behind`).
  - Paused matches are reproducible only given the same answers; an LLM gives different answers to
    the same report, so a repeated match is a new sample, not a replication.
  - Providers are asked in different forms (D64, Q18): Claude as an Agent SDK session, Codex as a
    Codex session, Gemini through the Interactions API, local models and OpenRouter as a request per
    decision with the last 3 turns. A comparison across providers measures the model with its
    provider's session tool (R13, R21).
  - Reported costs are the services' estimates (the Agent SDK's at API prices), not a bill.
  - A match whose layer stopped is a different condition from then on: count and report it.
  - The interval of `comparisons.csv` ignores the pairing by seed; the seeds and maps played are a
    sample of the possible battles, not all of them.
  - One machine, one code version per match (recorded): results from different code versions are not
    one sample.

## Tests

`tests/smoke/experiment.ts` (outside the repository, CASES 36) plays plans against a fake AI server
on 127.0.0.1 only; no real AI service is called. Run it with `./run-all.sh only experiment`.
