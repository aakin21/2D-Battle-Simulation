# Next steps (updated 2026-10-10)

Phase 2 and the UI work are both in `main` (2026-10-04). Each change gets its own branch from
`main`; `phase2/symmetry` (worktree `.claude/worktrees/phase2-symmetry/`) is kept equal to `main`.
Read `CLAUDE.md` (architecture, rules that must not be broken) and `THESIS_DOCUMENTATION.md`
(decision, research and problem logs) first. Discussion with the author is in Turkish; docs in English.

## Working agreements
- Do not run live AI tests (real LLM via the Agent SDK, real Jev API). The author runs them;
  give run steps and analyse what they paste back. Headless tests with fake AIs are fine.
- Do not update `THESIS_DOCUMENTATION.md` while a topic is being discussed; log when the author
  confirms. Only thesis-level items, not small bugs.
- Every change: its own branch, merged into `main` (features are tagged), pushed, then `main` is
  merged into `development`, which deploys the live demo. Smoke-test and check edge cases first.
- Nothing that lowers FPS goes in without being measured and solved (FX on and off, see
  `UI_PLAN.md` for earlier measurements).
- Visual effects are rendering-only, switch off with the FX button and never change simulation
  results.
- The simulation's rules must not change for performance (no staggered updates or
  approximations). Optimizations must give identical results, proven by a test. The author
  prefers short, targeted tests over 15–20 min runs.
- Headless test scripts live outside the repo (author's decision, D24). Bundle a test with
  `npx esbuild <file>.ts --bundle --platform=node --outfile=<file>.cjs` and run it with node.
  `../tests/smoke/run-all.sh` builds and runs every smoke test; `../tests/smoke/CASES.md`
  lists every case tried in the robustness passes with its outcome.
  Equivalence tests for D31 and D32: `../tests/d27/` and `../tests/paths/` (see their READMEs).
- Jev key: `.env.local` (git-ignored). Restart `npm run dev` after changing it.
- Git pushes use the `aakin21` GitHub account. The machine's active `gh` account may be
  another one; push with `GH_TOKEN="$(gh auth token --user aakin21)" git push ...` instead of
  switching accounts. The full sprite pack (CC0, D25) is at `../Ninja Adventure - Asset Pack.zip`.
- Pushing a change to `.github/workflows/` needs the `workflow` scope on the `aakin21` token
  (it has only `repo`, `gist`, `read:org`; GitHub refuses the push otherwise). `gh auth refresh`
  acts on the active account, so the author switches to `aakin21`, runs
  `gh auth refresh -h github.com -s workflow`, and switches back.

## Start here (2026-10-10)
The robustness work stopped mid-pass. **Read `../tests/smoke/STATUS.md` first**: where we are,
every test file, the releases made, the verified open fixes (two high-severity gaps in the
tunnel access, D37: dot-segment paths skip the guard; `/.git/` is served through the tunnel)
and the partial results of the stopped agents. Every case tried is in `../tests/smoke/CASES.md`.

## Just done (2026-10-07 to 10)
- Seventh robustness pass (`v2.8.3-robustness-7`, local): `/API/llm` in capitals and absolute
  request targets skipped the access check (fixed); orders to a resting hero wait until it is
  healed (design question); a side without heroes is slow per frame (measured, not changed).
  Subagents reviewed server security and tooling; their findings are in `../tests/smoke/agents/`.
- Sixth robustness pass (`v2.8.2-robustness-6`, local). Three fixes change what the AI layers
  read, so the author should know: Jev's regroup option now names the group the order really
  goes to (it named the nearest one, while the order picks by distance and size); Jev's local
  map shows "M" for every 2×2 cell with a mountain tile (17–19% of such cells showed as
  passable); the LLM's rulebook now lists all of Jev's actions (it left out regroup, control
  points and the base). Also: LLM commands are read case-insensitively and "point A" is
  understood; a sideways trackpad swipe no longer zooms out; a selection off the canvas is
  cancelled.
- Fifth robustness pass, function by function (`v2.8.1-robustness-5`, local): an LLM report
  whose request failed lost its events and its "since the last report" baseline; sector names
  with spaces around the dash or a typographic dash were refused and "D4-NE-X" accepted; stray
  clustering took ~10 ms per call with 2,000 soldiers per side (now ~11× faster, identical
  results); the demo link's AI address without `https://` or with a path gave a 404, a damaged
  saved copy sent requests to "123/api/llm"; the Vercel Jev proxy threw when TypeSafe was
  unreachable and hung when it was silent; an `/api/llm` request whose client went away stayed
  pending. All smoke tests: `../tests/smoke/run-all.sh` (`quick` skips the 3-minute AI test).
  Design question for the author: a fleeing unit cornered at the map edge does not fight back.
- AI requests (`v2.8-ai-request-practices`, local): researched the services' own guidance
  (Claude Code errors and Agent SDK docs, TypeSafe API, models and retry docs) and applied what
  does not change the experiment design. Found and fixed: the Agent SDK's API errors, plan limits
  included ("You've hit your session limit"), reached the browser as the LLM's reply and were
  rejected as "not valid JSON"; any error closed the LLM session and erased the match's
  conversation (D11). Now: retryable failures are asked again at the next decision, 3 in a row
  stop a layer; Jev retries within a request like TypeSafe's SDKs; cost, tokens, API time and
  model ids (LLM) and the Jev version and tokens are recorded per decision; budget cap per LLM
  session (`LLM_MAX_BUDGET_USD`, default 5). Cases 4.7–4.19 in `../tests/smoke/CASES.md`.
- AI request log (`v2.7-ai-request-log`, local): every request to Jev and the LLM with its answer
  in the AI panel ("Requests and answers") and in the match log. It showed a D15 bug, fixed:
  an LLM order equal to the hero's Jev order was not remembered as the commander's.
- P7 logged (effects changed the simulation's random numbers) at the author's request.
- Third robustness pass (`v2.6.3-robustness-3`, local only). Every case tried in passes 2 and 3
  and its outcome is in `../tests/smoke/CASES.md`. Fixed: with FX on, effects drew from the
  simulation's `Math.random`, so the same seed gave a different battle (proved with the real
  renderer on a fake canvas, `render.ts`); the LLM match id did too. When an AI layer stops, the
  AI panel now shows the server's error text and what to do (e.g. Cloudflare 530: the tunnel
  address no longer exists). The author's test on the online demo on 2026-10-08 got such an
  HTTP 5xx: expected, since no `npm run dev` and tunnel were running and the demo is still the
  old version (nothing pushed).
- P5 (late AI answers reaching the next match) and P6 (other websites could use the local AI
  endpoints, a gap in D37) logged at the author's request.
- Second robustness pass (`v2.6.2-robustness-2`, local only, not pushed). New tests in
  `../tests/smoke/` (see its README): `edge.ts` 30/30, `server2.ts` 24/24 (12 failed on the old
  code, with a fake Agent SDK `sdk-fake.ts`), `same.ts` shows identical battlefield hashes on
  the old and new code in 18 cases; the earlier suites still pass (engine 84/84, AI 14/14,
  maps, server). Fixed: an exception in a simulation step froze the page (now a "Simulation
  stopped" card, recorded in the match log); a first frame could run time backwards; Cmd+R and
  Ctrl+± acted as game shortcuts and a held R restarted many times a second; an unreadable
  saved map silently became a random one, and saving under an existing name replaced a map
  unasked; any website open in the browser could POST to `localhost` `/api/llm` and `/api/jev`
  without the password (now refused by `Origin`); `/api/llm` requests waited 150 s on a closed
  or ended session; Jev values that are not numbers reached the AI panel's HTML.
- Demo version string (local only, not pushed): the deploy workflow checks out the full history
  with tags and installs with `npm ci` (`fix/deploy-version`, not tagged: no app change). In a
  `node:20` container with CI's Node 20.20.2 / npm 10.8.2, the old steps rewrite
  `package-lock.json` and give `<sha>-dirty`; the new ones leave the tree clean and give
  `v2.6.1-robustness-3-g<sha>`.
- Exact objective positions for both AI layers (`v2.1`, not logged at the author's request).
- UI redesign in the Ninja Adventure pixel style, all in the demo (details and measurements in
  `UI_PLAN.md`, "Phase 2 UI"): theme and full-window layout (`v2.2`), AI panel and match log
  (`v2.3`), terrain art (`v2.4`), unit animation and smart bars (`v2.5`), sound (`v2.6`).
- Project-wide smoke test and robustness fixes (`v2.6.1`). Tests outside the repo in
  `../tests/smoke/` (`engine.ts`, `ai.ts`, `maps.ts`, `server.ts`; build each with esbuild, the
  server test with `--alias:@anthropic-ai/claude-agent-sdk=../tests/smoke/sdk-stub.ts`).
  Results: engine 84/84, AI 14/14, maps 26/26, server 15/15. Fixed: late AI answers reaching
  the next match's heroes (controllers are disposed on restart), paused AI timing freezing
  forever without an answer (request timeouts), one malformed LLM order stopping the layer,
  unbounded `/api/llm` requests, damaged saved maps, classic mode crashing on a map without
  clear tiles, soldiers per side rounded down to a multiple of 3.
- 2026-10-06: `HANDOFF.md` removed; P4 logged and D18/D23 re-measured (R10).

## Open items, in order
1. **Pushed on 2026-10-10** (the `aakin21` token now has the `workflow` scope): all branches
   and tags are on GitHub; the deploy passed and the demo's version is
   `v2.8.3-robustness-7-24-ga564a76` (no `-dirty`). Optional follow-up: the workflow's Node 20
   actions (see `../tests/smoke/agents/tooling/FINDINGS.md`, T8).
2. **Before the next tunnel test:** close the two open gaps in P6 (dot-segment paths skip the
   access guard; Vite 5 serves `.git/` through the tunnel) and the small server fixes, see
   `../tests/smoke/STATUS.md`, "Open".
3. **Live tests by the author**, one by one (port of `npm run dev`): D33–D36 with Jev and the
   LLM; Jev only, Jev + LLM, each objective; the tunnel (D37) end to end; a re-run of the first
   LLM vs LLM match with the courage fix (P4, D3). The AI panel shows the decisions live, and
   the Log button (or "Download log" on the result card) saves settings, timeline and every AI
   decision as JSON, so nothing has to be copied from the browser console.
4. **Battle problems (algorithmic; to go through one by one with the author):**
   - A fleeing unit cornered at the map edge or by mountains does not fight back (only units in
     the attack state hit).
   - An order to a resting hero waits until it is fully healed (~16 s from 40 HP); orders end a
     flight (D18) but not a rest.
   - Wounded units are slower (speed × (0.5 + 0.5 × HP share)).
   - Classic waves never stop: ×10 waves reach ~21,000 units after 20 minutes.
   - A side with no heroes left: its soldiers search the whole map every frame (150/side: worst
     frame 59 ms; 2,000/side: 33 ms per step on average).
   - Rulebook per mode (to discuss): the stance rules are the same in every objective.
5. **AI requests (to go through with the author; the layers cannot yet say enough of what they
   want, and they should be able to send complete orders):**
   - What each layer can express: the LLM's order set (move, hold, retreat, attack, attack_hero,
     regroup, attack_base) and Jev's fixed option list; what is missing (e.g. a formation or
     spacing, a target group, conditions, an order for the soldiers, a reason that reaches the
     other layer).
   - Jev's options at the map edge or into mountains ("step 10 tiles west" that goes nowhere).
   - Proposals not applied: pin model versions (`jev-1.13.0`, full Claude ids), structured
     output for the LLM (`outputFormat: json_schema`), fewer CLI retries for real time, a fixed
     reasoning effort. Then log the research as R#.
   - Done 2026-10-10 (D38–D41, `v2.9-ai-intent`): Jev alone dropped; retreat falls back ~12
     tiles from the enemies; regroup described as group after group; every LLM order carries a
     reason that Jev reads (and the panel, the hero card and the log show). Next to discuss:
     Jev's map (one shared overview map with the heroes marked, plus the local maps?).
   - Done 2026-10-10 (`feature/ai-intent-2`): retreat now goes what the hero walks in 4 s (one Jev
     interval, ~8 tiles) instead of 12 tiles; each AI hero's order and the LLM's reason shown in the
     side AI panel (the hero card is one line again). D39 still says 12 tiles (author to confirm the
     amendment). Jev's map research done (see the chat of 2026-10-10): keep local maps small, add
     code-computed relational facts (groups with distance, direction, force), not a full map; A/B in
     the live tests with Jev's `input_tokens`; consider rotating the option order (first-option bias).
   - Changes made in the robustness passes that alter what the layers read (author to confirm):
     Jev's regroup text, Jev's local map, the rulebook sentence on Jev's actions, the LLM
     command and place spellings now accepted.
   - Also not decided: a seeded simulation for paired experiments (possible since P7).
6. Known, not fixed: stress-mode berserkers clip mountain corners by ~0.06 tiles (Phase 1
   classic behaviour, 6 units in 40 s; never seen in battle mode); one-off 90–220 ms frames in
   stress mode and base mode (Q17); a move order to a point off the map (no source gives one
   today) takes the ring search's first tile, which favours the top of the ring, or the point
   itself beyond 40 tiles; left as is because changing it could change results.
7. **AI in the online demo through a tunnel (D37):** `AI_PASSWORD=...` in `.env.local`,
   `npm run dev`, `cloudflared tunnel --url http://localhost:5173`, then open the demo once with
   `?ai=<tunnel address>&key=<password>`. Vercel with the Claude API comes later (D10).
8. Later ideas: cross-match learning (D11, research first), threat-aware pathfinding (D27),
   LLM as tactical layer vs Jev (to be logged as a new Q#; Q17 is taken).
9. **Experiments** (Q11, later, after items 4 and 5): conditions Rules / LLM / LLM + Jev (D38),
   timing modes, models (D29), objectives; metrics: win rate, time, losses, decision latency,
   skipped and failed requests, cost (now recorded per LLM answer). Needs a headless experiment
   runner with a safety cut-off per match; the match log format (`src/ui/MatchLog.ts`) can be
   reused.
