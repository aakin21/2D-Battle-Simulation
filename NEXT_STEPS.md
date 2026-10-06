# Next steps (updated 2026-10-06)

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

## Just done (2026-10-06, see the thesis log)
- `HANDOFF.md` removed; the rules that still apply are in the working agreements above.
- P4 (courage bug) logged; D18 and D23 re-measured with the fix (R10): D18 holds with a larger
  effect, D23's "every match ended" did not hold even with the bug.

## Open items, in order
1. **Live tests by the author**, one by one (port of `npm run dev`): D33–D36 with Jev and the
   LLM; Jev only, Jev + LLM, each objective; the tunnel (D37) end to end; a re-run of the first
   LLM vs LLM match with the courage fix (P4, D3). Collect `ai.east.jev.decisions` /
   `ai.east.llm.decisions` from the browser console.
2. **Exact objective positions for the AI** (author request): add exact tile coordinates
   (x, y) of points A/B and of both bases to the LLM report (`LlmController.objectiveReport`)
   and Jev's state (`JevController.objectiveState`), next to the sub-sector names. Also show
   each hero's distance/direction to them for the LLM.
3. **Rulebook per mode** (author request): checked 2026-10-06. Goal, scoring and orders in
   `src/ai/GameRules.ts` are per mode and nothing about other modes leaks in. Open point to
   discuss: the stance rules are the same in every mode ("defensive: hold good ground and let
   the enemy come"), which does not fit Control, where waiting loses points.
4. ~~Elimination stalemates~~: solved by the time limit (D33); rule heroes still often never
   meet in elimination (all 10 test matches ended on time).
5. ~~Courage bug~~: logged as P4, D18 and D23 re-measured (R10, 2026-10-06). The D3 match re-run
   is part of item 1.
6. **AI in the online demo through a tunnel (D37):** code done and deployed (2026-10-04). To use
   it: `AI_PASSWORD=...` in `.env.local`, `npm run dev`, `cloudflared tunnel --url
   http://localhost:5173`, then open the demo once with `?ai=<tunnel address>&key=<password>`.
   The end-to-end test is part of item 1. Vercel with the Claude API comes later, for the final
   experiments (D10).
7. **Experiments** (Q11): conditions Rules / Jev / LLM / Jev + LLM, timing modes, models
   (D29), objectives; metrics: win rate, time, losses, decision latency, skipped requests, cost.
   Needs a headless experiment runner with a safety cut-off per match.
8. Later ideas: cross-match learning (D11, research first), threat-aware pathfinding (D27),
   LLM as tactical layer vs Jev (to be logged as a new Q#; Q17 is taken).
