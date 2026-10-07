# src/rendering

Canvas drawing only; no simulation logic here.

| File | Role |
|---|---|
| `Renderer.ts` | Main canvas: terrain (cached offscreen), units, HP and courage bars, task points, charisma radius, camera, debug overlay, unit-card portrait |
| `MinimapRenderer.ts` | Minimap: one pixel per tile scaled up by whole pixels, control points, bases, heroes and the main view's rectangle |
| `TerrainArt.ts` | Battlefield art from the pack's tilesets, built once per map at 8 px per tile (the unit sprites' pixel size): textured ground, edges that follow the tiles, trees, rocks, reeds and flowers placed only on matching tiles |
| `ObjectiveArt.ts` | Waving flags on control points (holder's colour) and towers for bases (intact, damaged, ruined) |
| `UnitSprites.ts` | Unit sprite sheets (Ninja Adventure, CC0, D25): team tinting, hit-flash and corpse variants, one sprite per hero slot |
| `effects/` | Visual effects layer: frame-diff event detection (`EffectsManager`), hit flash, corpses, blood, status icons, hero aura; pooled objects and pre-rendered sprites |

## Conventions

- Read the battlefield, never change it.
- Battle mode is passed in with `setBattleMode()`: enemy soldiers show courage bars and enemy heroes use their own colour.
- The canvas fills its area in the page (`resize()`, called by the UI). The smallest zoom fits the whole map; along an axis where the map is smaller than the view it is centred, so the camera can be negative.
- Skip anything outside the visible canvas (culling); keep per-frame allocations out of hot loops.
- Colours for units and terrain come from `src/types/types.ts`.
- Effects, sprites and the terrain and objective art are rendering-only and switch off together with the FX button (off = the original squares and flat terrain colours). Effects detect hits and deaths by diffing unit state between frames; they never read or advance simulation randomness.
- Sprites and status icons draw for every visible unit at every zoom (no sprite budget since `v1.9.1`, no zoom limit since `v1.9.2`). Measure FPS with FX on and off before adding anything per-unit; see `UI_PLAN.md`.
