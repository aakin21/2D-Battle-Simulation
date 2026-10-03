# Next steps (handoff, 2026-10-03)

Work happens on branch `phase2/symmetry` in the worktree `.claude/worktrees/phase2-symmetry/`.
Read `CLAUDE.md` (architecture, rules that must not be broken) and `THESIS_DOCUMENTATION.md`
(decisions D1–D30, research R1–R5) first. Discussion with the author is in Turkish; docs in English.

## Working agreements
- Do not run live AI tests (real LLM via the Agent SDK, real Jev API). The author runs them;
  give run steps and analyse what they paste back. Headless tests with fake AIs are fine.
- Do not update `THESIS_DOCUMENTATION.md` while a topic is being discussed; log when the author
  confirms. Only thesis-level items, not small bugs.
- The author works on UI in parallel on `main`; do not reformat their UI files
  (`Renderer.ts`, `UIController.ts`, `index.html`, `effects/`).
- Headless test scripts live outside the repo (author's decision, D24). Bundle a test with
  `npx esbuild <file>.ts --bundle --platform=node --outfile=<file>.cjs` and run it with node.
- Jev key: `.env.local` (git-ignored). Restart `npm run dev` after changing it.

## Just done (2026-10-03, see the thesis log)
- D30 verified headless (control ends at 300 s, base ends when a base falls, rule heroes play
  the objective).
- D33 match time limit (elimination and base: 500 s, more total HP wins), D34 hero reflex v2
  (flee until no enemy in sight, AI/user orders end it, rule heroes rest after), D35 strays wait
  to be collected, D36 soldiers spawn across their side's area. Measurements in R9.
- `perf/neighbor-queries` (D31, D32) merged; both equivalence tests ALL PASS (R8).

## Open items, in order
1. **Real tests by the author** of D33–D36 with Jev and the LLM (see item 6).
2. **Exact objective positions for the AI** (author request): add exact tile coordinates
   (x, y) of points A/B and of both bases to the LLM report (`LlmController.objectiveReport`)
   and Jev's state (`JevController.objectiveState`), next to the sub-sector names. Also show
   each hero's distance/direction to them for the LLM.
3. **Rulebook per mode** (author request): check `src/ai/GameRules.ts` explains only the
   current mode (goal, orders, scoring). It already uses `goalText(objective)` and
   `objectiveOrders(objective)`; make sure nothing about other modes leaks in.
4. ~~Elimination stalemates~~: solved by the time limit (D33); rule heroes still often never
   meet in elimination (all 10 test matches ended on time).
5. **Courage bug (next free ID: P4; P2 and P3 are taken):** log in the Problems log that battle-mode enemy soldiers started with
   berserker courage 100 instead of 70 (fixed in commit 0fa3310); it affected the numbers in
   D18 (reflex), D23 (win test) and the first LLM vs LLM match (D3). Re-measure and update.
6. **Real tests by the author** (port of `npm run dev`): Jev only, Jev + LLM, each objective;
   collect `ai.east.jev.decisions` / `ai.east.llm.decisions` from the browser console.
7. **Vercel deploy:** author runs `npx vercel login` and `npx vercel link`, adds
   `TYPESAFE_API_KEY` to the project, then `npx vercel --prod` (api/jev.ts is ready; the LLM
   does not work on Vercel until the Claude API is used, D10).
8. **Merge** `phase2/symmetry` into `main` (expect conflicts in Renderer.ts, UIController.ts,
   index.html); delete the untracked copies of THESIS_DOCUMENTATION.md / CLAUDE.md / .claude/skills
   in the main checkout first.
9. **Experiments** (Q11): conditions Rules / Jev / LLM / Jev + LLM, timing modes, models
   (D29), objectives; metrics: win rate, time, losses, decision latency, skipped requests, cost.
   Needs a headless experiment runner with a safety cut-off per match.
10. Later ideas: cross-match learning (D11, research first), threat-aware pathfinding (D27),
    LLM as tactical layer vs Jev (to be logged as Q17).
