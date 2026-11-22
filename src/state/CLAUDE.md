# src/state

| File | Role |
|---|---|
| `StateManager.ts` | Owns the battlefield: terrain, units, heroes, spatial grid (and its neighbour queries), unit lookup, the berserker pool. Spawns units for classic, stress and battle modes and classic wave berserkers (`spawnBerserker`), places the battle objectives (D30) and the heroes where `BattleLayout` says, computes the map's main walkable region (the largest of the pathfinder's regions). |
| `BattleLayout.ts` | Where a battle starts on a map, from its terrain alone (nothing random): the hero columns and slots, the soldiers' columns, the objectives' places (D30: control points A and B, the bases, each on the main region's tile nearest to its spot), the main region (`mainRegionOf`, `nearestMainTile`). `StateManager` places a run with it and Match setup's map preview (`src/ui/MapPreview.ts`) draws the same places. |
| `TerrainGen.ts` | Random terrain (`generateTerrain(density, random)`): forest, swamp and mountain blobs, every draw from `random`: `Math.random` by default (a new map), or `seededRandom(seed)` (mulberry32, its own state: the same seed and density give the same map, `Math.random` is not drawn). `newTerrainSeed()` (one draw of `Math.random`) and `isTerrainSeed`. `StateManager.initGrid` uses it: with `SimConfig.terrainSeed` the map of that seed. |
| `MapStore.ts` | Encodes maps as compact text and saves/loads them in browser local storage (D5). |

## Conventions

- Add and remove units only through `addUnit` / `removeUnit`, so the spatial grid, unit map and hero list stay in sync. After moving a unit, call `syncPosition`.
- `removeUnit` swap-removes: the last unit takes the removed unit's place in `units`. Unit order decides the order units are updated in, so changing how units are removed changes results (the `same.ts` smoke test shows it).
- `getHero()` returns the first friendly hero (the only hero in classic mode); use `getHeroes()` for anything multi-hero.
- Battle-mode units spawn at tile centres and only inside the main walkable region (`isInMainRegion`), never in pockets enclosed by mountains.
- `reset(config)` rebuilds everything; a `presetGrid` in the config is copied, never mutated. Without one, `terrainSeed` makes the random map of that seed (Match setup hands the run the seed of the map it previewed: what you preview is what you get) and draws no `Math.random` for the terrain; without either, a new random map from `Math.random` (the headless suites, the Sandbox), as before.
- Dead berserkers go back into the pool (`BerserkerPool`) only in classic mode outside the stress test, the only mode that runs waves; the pool starts empty, and `acquire` sets every field a unit can change, so which object is handed out never decides anything.
- Local storage can be unavailable: every access in `MapStore` is wrapped and falls back safely.
- Battle mode spawns exactly `warriorCount` soldiers per side (as many as fit in the side's area); classic mode spawns the hero on any clear tile if its usual area has none, and none at all on a map without clear tiles.
- `decodeGrid` refuses anything malformed (not a string, wrong size, a run longer than the row) without allocating it.
