# Handoff (2026-10-03, updated)

State of the work on the visual effects (`UI_PLAN.md`) and the engine performance fixes (D31, D32). Read this first when continuing.

## Decision numbering

The neighbor-query optimization was first logged as **D27**. `phase2/symmetry` meanwhile used D27 for another decision ("Heroes can break off a fight"), so ours is now **D31**. Old commit messages on `perf/neighbor-queries` and on `main` (`88d6611`) still say D27; the thesis log and code comments say D31. The test folder is still called `../tests/d27/`.

## Branches

| Branch | What it contains | Status |
|---|---|---|
| `main` | Phase 1 simulation + visual effects + D31 + D32 (tags `v1.1-ui-infra` … `v1.12-ui-label-fixes`) | Pushed |
| `development` | `main` merged in | Pushed. **The live demo deploys from here** (`.github/workflows/deploy.yml`, GitHub Pages) |
| `phase2/symmetry` | Phase 2 AI work by another session (worktree `.claude/worktrees/phase2-symmetry`) | That session was working with uncommitted engine/AI changes on 2026-10-03. Do not write into its worktree |
| `perf/neighbor-queries` | `phase2/symmetry` (`4909800`) + `main` up to `v1.9.3` + D31 + D32 (cherry-picked) + thesis log P2, P3, R6, R7, R8, D31, D32, Q17 | Pushed, **not merged into `phase2/symmetry`**. Contains `merge/ui-budget-into-phase2` |
| `perf/neighbor-queries-main`, `perf/unreachable-paths`, `feature/ui-*`, `docs/renumber-d31` | One branch per change | Pushed, merged into `main` |

## What was done

- **D31 (Accepted):** neighbor queries (courage counts, nearest enemy) with a finer grid and per-cell faction counts. Identical results (R7; on `main` too: ~9.3 M queries, 0 mismatches). Stress engine time 10.6 → 4.3 ms per frame.
- **D32 (Accepted):** `Pathfinder` labels walkable regions once per map and returns `[]` at once when the target is in another region. This fixed the stress-mode drop to ~1 FPS (P3, R8): berserkers chasing unreachable targets re-ran a failed A* over their whole region every frame. Present since Phase 1. Only the short equivalence test was run (stress seed 2 ×4: 246 k path calls, 0 mismatches, identical trajectory); the full test was stopped at the author's request. After the fix the author saw ~100 FPS in stress mode.
- **UI label fixes (`v1.12`):** the red circle around a selected hero is its sight range (renamed `drawHeroSight`); the stress menu says 2200 warriors (what it spawns: 300 + 1,900).

## Open tasks, in order

1. **Merge `perf/neighbor-queries` into `phase2/symmetry`** once the other session has committed its work. Best before that session fixes its courage bug, since D31 rewrote the courage counting in `updateCourage`. Expect conflicts in `src/engine/SimulationEngine.ts`, `src/state/StateManager.ts` and `THESIS_DOCUMENTATION.md` (both sides added entries; check that no IDs collide again). Afterwards:
   - typecheck, lint, build;
   - run `../tests/d27/equiv.ts` (must print `ALL PASS`) and `../tests/paths/equiv.ts` (see their READMEs).
2. **`THESIS_DOCUMENTATION.md` on `main` is an old, untracked copy.** The real document is on the Phase 2 branches. Delete or move the `main` copy before merging Phase 2 into `main` (git refuses to overwrite an untracked file).
3. **Vercel (D8):** only needed when Phase 2 (Jev proxy) goes into the demo. The author runs `npx vercel login`, `npx vercel link`, adds `TYPESAFE_API_KEY`, then `npx vercel --prod`.

## Open points (not started)

- **Q17:** one ~165–175 ms frame in stress mode (frame 1,061 of the seeded benchmark), still there after D31 and D32, so not the unreachable-target searches.
- Sprites are drawn at every zoom (author's choice); before D31/D32 this cost ~16% FPS in stress mode. Probably no longer matters.

## Tests (outside the repository, per D24)

- `../tests/d27/`: D31 equivalence and speed. `equiv.ts`/`bench.ts` for the Phase 2 layout, `equiv-main.ts`/`bench-main.ts` for `main`. The stress scenario needs `node --max-old-space-size=12288`. `equiv-main.ts` takes an optional scenario filter (e.g. `stress`).
- `../tests/paths/`: D32 equivalence (`PathfinderOld.ts` is the original A*). Takes a scenario filter; the full run takes 15–20 min.

## Rules the author asked for

- Everything in the repository is in English; conversation with the author is in Turkish.
- No `Co-Authored-By` lines and no mention of AI tools in commits or PRs.
- Every feature: its own branch, merged into `main`, tagged, pushed. Smoke test and edge cases before pushing; nothing that lowers FPS goes in without being measured and solved.
- Visual effects are rendering-only and switch off with the FX button; they must not change simulation results.
- The simulation's rules must not change for performance (e.g. no staggered updates). Optimizations must give identical results, proven by a test. The author prefers short tests over 15–20 min runs.
- Thesis log: follow `CLAUDE.md` and the `thesis-log` skill. Decisions are `Accepted` only after the author confirms.

## Practical notes

- Git pushes use the `aakin21` GitHub account (`gh auth status`).
- Sprites: Ninja Adventure pack (CC0), see D25 and `src/assets/sprites/LICENSE.txt`. The full pack zip is at `../Ninja Adventure - Asset Pack.zip`.
- Measurement notes, FPS numbers and design choices for each effects step are in `UI_PLAN.md`.
