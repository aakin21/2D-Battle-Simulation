# Next steps (updated 2026-10-08)

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
  Equivalence tests for D31 and D32: `../tests/d27/` and `../tests/paths/` (see their READMEs).
- Jev key: `.env.local` (git-ignored). Restart `npm run dev` after changing it.
- Git pushes use the `aakin21` GitHub account. The machine's active `gh` account may be
  another one; push with `GH_TOKEN="$(gh auth token --user aakin21)" git push ...` instead of
  switching accounts. The full sprite pack (CC0, D25) is at `../Ninja Adventure - Asset Pack.zip`.
- Pushing a change to `.github/workflows/` needs the `workflow` scope on the `aakin21` token
  (it has only `repo`, `gist`, `read:org`; GitHub refuses the push otherwise). `gh auth refresh`
  acts on the active account, so the author switches to `aakin21`, runs
  `gh auth refresh -h github.com -s workflow`, and switches back.

## Just done (2026-10-07 / 08)
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
1. **Push the local work** once the token has the `workflow` scope (see Working agreements):
   `main`, `phase2/symmetry`, `development`, `fix/deploy-version`,
   `docs/next-steps-deploy-version`, `fix/robustness-2`, `docs/next-steps-robustness-2`,
   `docs/p5-p6` and the tag `v2.6.2-robustness-2` are ahead of `origin` locally. Then check that the deploy run passes and that the demo's
   `assets/index-*.js` on `gh-pages` has a tag-based `version` without `-dirty`. Optional
   follow-up: the run warns that Node 20 is deprecated (`checkout@v4`, `setup-node@v4`,
   `actions-gh-pages@v3` are forced onto Node 24; the build itself uses Node 20).
2. **Live tests by the author**, one by one (port of `npm run dev`): D33–D36 with Jev and the
   LLM; Jev only, Jev + LLM, each objective; the tunnel (D37) end to end; a re-run of the first
   LLM vs LLM match with the courage fix (P4, D3). The AI panel shows the decisions live, and
   the Log button (or "Download log" on the result card) saves settings, timeline and every AI
   decision as JSON, so nothing has to be copied from the browser console.
3. **Rulebook per mode** (to discuss): the stance rules are the same in every mode ("defensive:
   hold good ground and let the enemy come"), which does not fit Control, where waiting loses
   points. Also proposed and not decided: a seeded simulation (same map and seed, same match)
   for paired experiments.
4. **Experiments** (Q11): conditions Rules / Jev / LLM / Jev + LLM, timing modes, models
   (D29), objectives; metrics: win rate, time, losses, decision latency, skipped requests, cost.
   Needs a headless experiment runner with a safety cut-off per match; the match log format
   (`src/ui/MatchLog.ts`) can be reused.
5. Known, not fixed: stress-mode berserkers clip mountain corners by ~0.06 tiles (Phase 1
   classic behaviour, 6 units in 40 s; never seen in battle mode); one-off 90–220 ms frames in
   stress mode and base mode (Q17); a move order to a point off the map (no source gives one
   today) takes the ring search's first tile, which favours the top of the ring, or the point
   itself beyond 40 tiles; left as is because changing it could change results.
6. **AI in the online demo through a tunnel (D37):** `AI_PASSWORD=...` in `.env.local`,
   `npm run dev`, `cloudflared tunnel --url http://localhost:5173`, then open the demo once with
   `?ai=<tunnel address>&key=<password>`. Vercel with the Claude API comes later (D10).
7. Later ideas: cross-match learning (D11, research first), threat-aware pathfinding (D27),
   LLM as tactical layer vs Jev (to be logged as a new Q#; Q17 is taken).
