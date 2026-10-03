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

## Just done (D30, needs checking)
- Objectives: Elimination / Control A-B / Base, selectable in the Battle menu.
- Battle menu now also shows soldiers per side and terrain (wave setting hidden).
- Verified so far: control points placed in the main region and points scored.

## Open items, in order
1. **Finish verifying D30** (headless): a full control match ends at 300 s on points; a base
   match ends when a base falls; rule heroes go to points / the enemy base.
2. **Exact objective positions for the AI** (author request): add exact tile coordinates
   (x, y) of points A/B and of both bases to the LLM report (`LlmController.objectiveReport`)
   and Jev's state (`JevController.objectiveState`), next to the sub-sector names. Also show
   each hero's distance/direction to them for the LLM.
3. **Rulebook per mode** (author request): check `src/ai/GameRules.ts` explains only the
   current mode (goal, orders, scoring). It already uses `goalText(objective)` and
   `objectiveOrders(objective)`; make sure nothing about other modes leaks in.
4. **Elimination stalemates:** 3 of 8 headless elimination matches (west heroes ordered to
   attack, east rule heroes) did not end in 900 s, e.g. "west 53 idle vs east 111 idle" and
   "west 1 fleeing vs east 55 idle". Find out why both sides stand (heroes alive? unreachable
   attack targets? fleeing unit faster than chasers). Objective modes reduce the impact but
   elimination should still finish.
5. **Courage bug P2:** log in the Problems log that battle-mode enemy soldiers started with
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
