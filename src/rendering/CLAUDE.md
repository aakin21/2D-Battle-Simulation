# src/rendering

Canvas drawing only; no simulation logic here.

| File | Role |
|---|---|
| `Renderer.ts` | Main canvas: terrain (cached offscreen), units, HP and courage bars, task points, charisma radius, camera, debug overlay |
| `MinimapRenderer.ts` | Minimap with the camera viewport |
| `effects/` | Visual effects (hit flashes etc.) with pooled objects |

## Conventions

- Read the battlefield, never change it.
- Battle mode is passed in with `setBattleMode()`: enemy soldiers show courage bars and enemy heroes use their own colour.
- Skip anything outside the visible canvas (culling); keep per-frame allocations out of hot loops.
- Colours for units and terrain come from `src/types/types.ts`.
