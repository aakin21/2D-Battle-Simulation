# Handoff (2026-10-03)

State of the work at the end of the session that built the visual effects (`UI_PLAN.md`) and the neighbor-query optimization (D27). Read this first when continuing.

## Branches

| Branch | What it contains | Status |
|---|---|---|
| `main` | Phase 1 simulation + visual effects (tags `v1.1-ui-infra` … `v1.9.3-ui-smaller-blood`) | Pushed. Original (pre-D27) engine |
| `development` | `main` merged in | Pushed. **The live demo deploys from here** (`.github/workflows/deploy.yml` runs on push to `development`) |
| `phase2/symmetry` | Phase 2 AI work by another session (worktree `.claude/worktrees/phase2-symmetry`, locked) | Contains the effects up to `v1.9-ui-wrap-up`. That session was still working, with uncommitted engine/AI changes, on 2026-10-03 |
| `merge/ui-budget-into-phase2` | `phase2/symmetry` (`c31c8dc`) + `main` up to `v1.9.3` + thesis log P2, R6, D27, D25 update | Pushed, **not yet merged into `phase2/symmetry`** |
| `perf/neighbor-queries` | `merge/ui-budget-into-phase2` + `phase2/symmetry` (`4909800`) + D27 implementation + thesis log R7, P2 resolved, Q17 | Pushed, **not merged anywhere** |
| `feature/ui-*` | One branch per effects step | Pushed, already merged into `main` |

## Open tasks, in order

1. **Confirm D27.** It is implemented and verified (R7: identical simulation in all tested scenarios; stress engine time 10.4 → 4.3 ms per frame) but stays `Proposed` until the author confirms. Then set its status in the decision table to `Accepted (date)`.
2. **Merge `perf/neighbor-queries` into `phase2/symmetry`** once the other session's work is committed (it also brings in `merge/ui-budget-into-phase2`). Expect conflicts in `src/engine/SimulationEngine.ts` and `src/state/StateManager.ts` (both had uncommitted changes there). Afterwards:
   - typecheck, lint, build;
   - run the equivalence test in `../tests/d27/` (see its README). It must print `ALL PASS`. If it does not, D27 is not adopted.
3. **D27 for `main` and the demo.** `main` still has the original engine. Either port D27 to it (`SpatialGrid.ts`; courage counting in `SimulationEngine.updateCourage`; `findNearestEnemy` in `SimulationEngine`) and deploy via `development`, or wait until Phase 2 is merged into `main`. Run the equivalence test against that code either way.
4. **`THESIS_DOCUMENTATION.md` on `main` is an old, untracked copy.** The real document is on the Phase 2 branches. Delete or move the `main` copy before merging Phase 2 into `main` (git refuses to overwrite an untracked file).

## Open points (not started)

- **Q17:** one ~165 ms frame in stress mode (same before and after D27), probably many units re-pathing at once when one side is wiped out.
- Sprites are drawn at every zoom (author's choice); in stress mode this costs ~16% FPS. The author wants to revisit this later.
- The red circle shown for a selected hero uses `hero.sight` (15 tiles) although its code comment calls it the influence area; the hero aura shows the real charisma radius (10 tiles).
- Stress mode spawns 2,200 warriors (default 300 + 1,900) while the menu says 2,000. Pre-existing.

## Rules the author asked for

- Everything in the repository is in English; conversation with the author is in Turkish.
- No `Co-Authored-By` lines and no mention of AI tools in commits or PRs.
- Every feature: its own branch, merged into `main`, tagged, pushed. Smoke test and edge cases before pushing; nothing that lowers FPS goes in without being measured and solved.
- Visual effects are rendering-only and switch off with the FX button; they must not change simulation results.
- The simulation's rules must not change for performance (e.g. no staggered updates). Optimizations must give identical results, proven by a test.
- Thesis log: follow `CLAUDE.md` and the `thesis-log` skill. Decisions are `Accepted` only after the author confirms.

## Practical notes

- Git pushes use the `aakin21` GitHub account (`gh auth status`).
- Sprites: Ninja Adventure pack (CC0), see D25 and `src/assets/sprites/LICENSE.txt`. The full pack zip is at `../Ninja Adventure - Asset Pack.zip`.
- Measurement notes, FPS numbers and design choices for each effects step are in `UI_PLAN.md`.
