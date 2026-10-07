# src/state

| File | Role |
|---|---|
| `StateManager.ts` | Owns the battlefield: terrain, units, heroes, spatial grid, unit lookup. Generates terrain, spawns units for classic, stress and battle modes, computes the map's main walkable region. |
| `MapStore.ts` | Encodes maps as compact text and saves/loads them in browser local storage (D5). |

## Conventions

- Add and remove units only through `addUnit` / `removeUnit`, so the spatial grid, unit map and hero list stay in sync. After moving a unit, call `syncPosition`.
- `getHero()` returns the first friendly hero (the only hero in classic mode); use `getHeroes()` for anything multi-hero.
- Battle-mode units spawn at tile centres and only inside the main walkable region (`isInMainRegion`), never in pockets enclosed by mountains.
- `reset(config)` rebuilds everything; a `presetGrid` in the config is copied, never mutated.
- Local storage can be unavailable: every access in `MapStore` is wrapped and falls back safely.
- Battle mode spawns exactly `warriorCount` soldiers per side (as many as fit in the side's area); classic mode spawns the hero on any clear tile if its usual area has none, and none at all on a map without clear tiles.
- `decodeGrid` refuses anything malformed (not a string, wrong size, a run longer than the row) without allocating it.
