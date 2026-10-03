# src/engine

The simulation itself. `SimulationEngine` owns the loop; the other files are parts it uses.

| File                  | Role                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SimulationEngine.ts` | Main loop: AI ticks → hero commands → courage → behavior → movement → rest → combat → deaths → match end / waves |
| `HeroCommands.ts`     | Command interface (D20): `issue()` stores an order, `applyAll()` turns orders into task points each frame        |
| `RuleHeroes.ts`       | Rule-based heroes (no AI): attack when an enemy is in sight, otherwise patrol                                    |
| `HeroReflex.ts`       | Hero survival reflex and retreat movement (D18)                                                                  |
| `GroupPatrol.ts`      | Random patrol destinations (classic berserker waves and rule heroes)                                             |
| `UnitHelpers.ts`      | Shared helpers: nearest enemy, effective sight, terrain speed, stepping, reachable tiles                         |
| `Pathfinder.ts`       | A\* with a binary heap and path smoothing; mountains and their neighbours are blocked                            |
| `SpatialGrid.ts`      | Spatial hash for neighbour queries                                                                               |
| `BerserkerPool.ts`    | Object pool for classic wave berserkers                                                                          |
| `Sectors.ts`          | 10×10 sector grid (A1–J10) and 3×3 sub-sectors (e.g. `D4-NE`) used to describe locations to the AI (D17, D26)    |
| `Rules.ts`            | The numbers that define behavior (combat range, courage formula, charisma, rest, hero reflex)                    |

## Conventions

- Order of a frame matters: AI ticks and command application run before behavior and movement.
- Unit states: `IDLE → ATTACK → FLEE → REST`. Soldiers flee on low courage; heroes "flee" only through the reflex.
- In battle mode berserkers are soldiers (`isSoldier`) and follow the nearest hero of their side within its sight (`findLeader`).
- Rule numbers live in `Rules.ts`. The AI rulebook (`src/ai/GameRules.ts`) is built from them, so change a rule there and the prompts follow. Other tuning constants are named at the top of the file that uses them.
- Pure helpers take the `StateManager` as their first argument instead of reaching into the engine.
- Classic-mode code paths (waves, berserker chase/patrol) must not change behavior; battle-only logic is guarded by `battleMode`.
