# src/engine

The simulation itself. `SimulationEngine` owns the loop; the other files are parts it uses.

| File | Role |
|---|---|
| `SimulationEngine.ts` | Main loop: AI ticks → hero commands → courage → behavior → movement → rest → combat → deaths → match end / waves |
| `HeroCommands.ts` | Command interface (D20): `issue()` stores an order, `applyAll()` turns orders into task points each frame |
| `RuleHeroes.ts` | Rule-based heroes (no AI): attack when an enemy is in sight, otherwise patrol |
| `HeroReflex.ts` | Hero survival reflex and retreat movement (D18) |
| `GroupPatrol.ts` | Random patrol destinations (classic berserker waves and rule heroes) |
| `UnitHelpers.ts` | Shared helpers: nearest enemy, effective sight, terrain speed, stepping, reachable tiles |
| `Pathfinder.ts` | A* with a binary heap and path smoothing; mountains and their neighbours are blocked |
| `SpatialGrid.ts` | Spatial hash for neighbour queries |
| `BerserkerPool.ts` | Object pool for classic wave berserkers |
| `Sectors.ts` | 10×10 sector grid (A1–J10) used to describe locations to the AI (D17) |

## Conventions

- Order of a frame matters: AI ticks and command application run before behavior and movement.
- Unit states: `IDLE → ATTACK → FLEE → REST`. Soldiers flee on low courage; heroes "flee" only through the reflex.
- In battle mode berserkers are soldiers (`isSoldier`) and follow the nearest hero of their side within its sight (`findLeader`).
- Constants that shape behavior (thresholds, ranges, speeds) are named at the top of the file that uses them.
- Pure helpers take the `StateManager` as their first argument instead of reaching into the engine.
- Classic-mode code paths (waves, berserker chase/patrol) must not change behavior; battle-only logic is guarded by `battleMode`.
