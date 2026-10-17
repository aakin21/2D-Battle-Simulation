# src/engine

The simulation itself. `SimulationEngine` owns the loop; the other files are parts it uses.

| File                  | Role                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SimulationEngine.ts` | Main loop: AI ticks → hero commands → courage → behavior → movement → rest → combat → objectives → deaths → match end / waves |
| `HeroCommands.ts`     | Command interface (D20): `issue()` stores an order, `applyAll()` turns orders into task points each frame        |
| `RuleHeroes.ts`       | Rule-based heroes (no AI): attack when an enemy is in sight, otherwise take a control point or attack the enemy base (D30), otherwise patrol |
| `HeroReflex.ts`       | Hero survival reflex and retreat movement (D18, D45, D47)                                                        |
| `Objectives.ts`       | Battle objectives (D30): control points scored by majority, bases that units attack, match end by objective or time |
| `Strays.ts`           | Stray soldiers (D28): soldiers with no hero in sight, grouped into clusters for the AI and for regroup orders (D40) |
| `ClassicWaves.ts`     | Classic mode (D19): berserker waves from the map edges, and the path of a wave berserker (chase its target or patrol with its group) |
| `GroupPatrol.ts`      | Random patrol destinations (classic berserker waves and rule heroes)                                             |
| `UnitHelpers.ts`      | Shared helpers: nearest enemy, effective sight, terrain speed, stepping, reachable tiles                         |
| `Pathfinder.ts`       | A\* with a binary heap and path smoothing; mountains and their neighbours are blocked (`isBlocked`); walkable regions (`labelRegions`) |
| `SpatialGrid.ts`      | Spatial hash for neighbour queries; a finer grid with per-cell faction counts makes courage counts and nearest-enemy search fast in crowds with identical results (D31) |
| `BerserkerPool.ts`    | Object pool for classic wave berserkers                                                                          |
| `Sides.ts`            | The two sides (West = friendly, East = enemy): `opponent()` and `sideName()`                                     |
| `Sectors.ts`          | 10×10 sector grid (A1–J10) and 3×3 sub-sectors (e.g. `D4-NE`) used to describe locations to the AI (D17, D26)    |
| `Separation.ts`       | Battle mode: units take up room, pushing each other apart (D53), never into a mountain buffer or another walkable region; a hero is not pushed by its own side |
| `Rules.ts`            | The numbers that define behavior (combat range, courage formula, charisma, rest, hero reflex)                    |

## Conventions

- Order of a frame matters: AI ticks and command application run before behavior and movement.
- The frame loop never runs time backwards (a frame can begin just before `start()`). An exception in a simulation step stops the run (paused, `getError()`, `setOnError`) instead of the loop; `resume()` refuses until a restart. A drawing error is logged once and the run goes on.
- `issueCommand` ignores a move or hold whose point is not a finite number.
- `issue` compares orders by what they run: Jev's "follow the LLM" (`continueLlm`) runs the LLM's latest order, so the LLM restating that order, or Jev following the order already running, is a repeat (no new point, age kept, no break-off, the reflex goes on). An LLM order that restates Jev's takes over its point.
- A retreat order falls back from the enemies within `RETREAT_SCAN` (20) tiles as far as the hero walks in `RETREAT_SECONDS` (5: one Jev interval plus its answer time, about 10 tiles), worked out once when given; repeated once the hero has reached that point (and is not fleeing by its reflex), it falls back further from the enemies near it then (D39); a regroup order collects stray groups one after another, since its target is re-evaluated as groups join (D40).
- Unit states: `IDLE → ATTACK → FLEE → REST`. Soldiers flee on low courage; heroes "flee" only through the reflex (D18), which a user, Jev or LLM order can end. The reflex starts when a hero is hurt (below 50% HP) and more enemies than allies are in its sight, or when at least 5 enemies outnumber its allies 2 to 1 (D45). Below `HERO_CRITICAL_HP_RATIO` (25%) a hero flees from any enemy in sight and no order ends that flight; an order that ends a flight keeps the reflex off until the hero's sight is clear or for `HERO_REFLEX_OFF_SECONDS` (5 s), whichever comes first (D47). In battle mode a hero below `HERO_REST_TRIGGER_HP` (100) rests whenever it stands still with no enemy in sight; a hero of the user, Jev or the LLM stops resting as soon as an order sends it somewhere (D45).
- In battle mode berserkers are soldiers (`isSoldier`) and follow the nearest hero of their side within its sight (`findLeader`). A soldier with no such hero stays where it is, also when its side has no heroes left (D35, D42).
- Rule numbers live in `Rules.ts`. The AI rulebook (`src/ai/GameRules.ts`) is built from them, so change a rule there and the prompts follow. Other tuning constants are named at the top of the file that uses them.
- Pure helpers take the `StateManager` as their first argument instead of reaching into the engine.
- Classic-mode code paths (waves, berserker chase/patrol) must not change behavior; battle-only logic is guarded by `battleMode`.
- Neighbour queries must return exactly what a plain scan returns (D31). Courage uses `countByFactionInRadius`, nearest enemy uses `nearestEnemyInRadius` with a full-scan fallback on exact ties. Changes here must pass the equivalence test (`../tests/d27/`, outside the repo).
