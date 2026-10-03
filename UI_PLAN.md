# UI / Visual Effects Plan

Visual polish for the simulation: hit flashes, light blood, death animation, status icons, hero aura, sprites, and a loading screen. Implemented step by step; each step is a separate commit, reviewed in the browser before moving on.

## Core principle: the engine is not touched

All effects live in the rendering layer. `SimulationEngine` gets no new code. The renderer keeps each unit's previous state (hp, position) and detects events by diffing frames:

- **hp dropped** → hit → flash + blood particles
- **unit disappeared from the list** → death → corpse + blood decal
- **position changed** → moving; movement direction gives sprite facing

This keeps simulation logic, AI integration, and reproducibility (D5) unaffected. Effects may use `Math.random` freely: they never read or advance any simulation RNG, so a future seeded simulation stays reproducible.

Effect time is simulation time (`battlefield.elapsedTime`): effects freeze while paused and follow the speed multiplier.

## Steps

| # | Step | Status |
|---|---|---|
| 0 | Infrastructure | ✅ |
| 1 | Hit flash | ✅ |
| 2 | Death animation | ✅ |
| 3 | Light blood | ✅ |
| 4 | Status icons | ✅ |
| 5 | Hero aura | ✅ |
| 6 | Sprites | ✅ |
| 7 | "Building simulation" loading screen | ✅ |
| 8 | Wrap-up | ✅ |

### 0. Infrastructure
- `src/rendering/effects/EffectsManager.ts`: frame-diff event detection (hits, deaths, facing), keyed by unit id.
- `src/rendering/effects/Pool.ts`: fixed-capacity `Pool` (particles) and `RingBuffer` (decals); no allocation in the frame loop.
- "FX: On/Off" button in the control bar (instead of the config screen, so it can be toggled mid-run for FPS comparison), persisted in localStorage.
- Debug overlay shows cumulative FX hit/death counts.
- `BerserkerPool` assigns a new id on reuse, so id-keyed diffing is safe. Unit ids restart from 0 on every run, so effects reset on restart (and auto-reset if sim time goes backwards).
- Verified: pause freezes events; restart and FX re-enable produce no fake death burst; FX setting survives reload; stress mode (4199 units) 60 FPS with FX on and off.

### 1. Hit flash
- A unit that takes damage renders white for 90 ms.
- Uses real time (not sim time) so the flash stays visible at 4x speed; no new hits occur while paused.
- Expired flashes are pruned every update, including off-screen units that are never drawn.
- Verified: white pixels on canvas 331 (FX on) vs 0 (FX off); stress-mode FPS identical to the pre-UI baseline.

### 2. Death animation
- `src/rendering/effects/Corpses.ts`. Over 0.4 s the unit square tips over to a random 20°–70° angle (either side) and its color darkens. (First version flattened the square into a rectangle; changed to a tilted square after review.) The body lies on the ground and fades out over the last 1.5 s of a 5 s life (sim time, so it freezes while paused).
- Max 1500 corpses (pooled); deaths beyond that are not drawn.
- Performance: lying opaque corpses are batched into one `Path2D` per unit type (3 fills per frame instead of one fill + `globalAlpha` change per corpse); cos/sin of the final angle are cached at spawn. Before batching, stress mode was 1–3 FPS slower than step 1; after batching it is within measurement noise (uncapped headless: avg ~47 FPS for both).

### 3. Light blood
- Agreed look (from step 2 review): corpse keeps its unit color, with a small dark red pool underneath. Hero corpse color darkened (`#3d0000`) so it stays visible on blood.
- `src/rendering/effects/Blood.ts`: 2–3 droplets per hit (0.35 s, max 800, one batched path). Each death leaves a pool that spreads over 0.8 s and fades over the last 8 s of a 25 s life (max 1500, ring buffer).
- Debug overlay also shows live corpse and pool counts. A real stress battle peaked around 100 corpses / 200 pools.

**Performance work (FPS must not drop):**
- First version drew corpses and pools as paths every frame. Worst case (1500 of each on screen) cost 6–14 ms per frame vs 2.4 ms for drawing all units. Measured the same with a real GPU, so not a headless artifact.
- `src/rendering/effects/sprites.ts`: corpses and pools are pre-rendered sprites drawn with `drawImage`. Corpses: 3.7–5.7 → 1.4–1.9 ms worst case.
- Settled pools are baked into a map-sized layer (8 px/tile) shown with a single `drawImage`, like the terrain. Pools: 2.6–8 → 0.2 ms at full-map zoom.
- The layer is rebuilt once per sim second for fading. The rebuild is spread over frames (200 pools per frame) into a back buffer and swapped in when done. A one-frame rebuild had cost 3.5 ms median / 14 ms max.
- Zoomed in past 12 px/tile, the layer would look blocky, so visible pools are drawn live from the full-resolution sprites (few are visible at that zoom).
- Sprites and layers are built and uploaded to the GPU at startup. Otherwise the first death cost a ~15 ms frame (14 ms cold vs 3.5 ms warm).
- Result: in a real stress battle, paused so only rendering runs, effects cost ~0.2–0.3 ms per frame (FX on 338–347 FPS vs off 371–376 uncapped). Early-battle FPS is the same as step 2 within run-to-run noise.
- Note: FPS dips to single digits late in heavy stress battles. These happen with and without effects, and on the pre-UI code too, so they are engine load (pathfinding/combat), not rendering.

### 4. Status icons
- `src/rendering/effects/StatusIcons.ts`: a yellow "!" hops above units in FLEE; a light blue "z" floats up and fades above units in REST. Dark outline for contrast on any terrain. Animation uses sim time (freezes on pause).
- Shown at zoom ≥ 9 px/tile (units 18 px wide). Icon size scales with zoom, 16–30 px. Drawn above HP bars. Covered by the FX toggle.
- Pre-rendered glyph sprites (no per-frame `fillText`), uploaded to the GPU at startup.
- Performance: 0.06 ms at full-map zoom (pass is skipped). Worst case of 1000 icons in view at zoom 9: 0.9 ms. A real battle has tens to a few hundred fleeing/resting units in view.

### 5. Hero aura
- `src/rendering/effects/HeroAura.ts`: an orange-gold breathing glow, a steady edge ring and an expanding ripple (2 s period, sim time) at `hero.charismaRadius` (10 tiles): the radius the engine actually uses for the courage bonus. Drawn on the ground (over blood/corpses, under units). Covered by the FX toggle.
- The existing red circle shown when the hero is selected is kept unchanged. Note: it uses `hero.sight` (15 tiles) although its code comment calls it the influence area, so with the hero selected both circles are visible (aura 10, sight 15).
- Cost: a few draw calls per frame (one hero).

### 6. Sprites
- Pack: Ninja Adventure (CC0), chosen in THESIS_DOCUMENTATION.md D25 / R4. Credited in README; license in `src/assets/sprites/LICENSE.txt`.
- Characters: warrior = Knight, berserker = Lion. Heroes: KnightGold, Master, Samurai (friendly) and ShamanLion, LionOrange, Tengu (enemy). Phase 1 uses only KnightGold; the others are for 3 heroes per side (D13).
- Sheet layout verified against the pack's separate animation files: columns down/up/left/right, rows 0–3 walk (row 0 = idle), row 4 attack, row 6 col 0 dead.
- `src/rendering/UnitSprites.ts`: warriors and berserkers are tinted 80% toward their team color (yellow / blue), keeping shading and dark outlines. Heroes keep their own colors and get a team-colored ring at their feet. Each sheet also has a white silhouette (hit flash) and a darkened copy (corpses), all built once at load.
- Animation: facing from movement (left/right columns), 4-frame walk at 8 fps while moving (per-unit random phase), attack frame for 0.25 s after each hit (from `attackCooldown`), idle otherwise. Sim time, so it freezes on pause.
- Corpses in sprite mode use the dead frame: the living frame crossfades into it over 0.4 s.
- LOD: sprites at zoom ≥ 9 px/tile; squares below. FX off shows the original squares.
- **Performance:** a sprite costs ~1.1 µs to draw vs ~0.3 µs for a square (1500 units: 1.6 vs 0.4 ms). Atlas, ImageBitmap and integer coordinates made no difference. So the number of sprites is capped instead: above 800 visible units the view falls back to squares, and returns to sprites below 650 (the gap prevents flicker). Worst-case extra cost ~0.7 ms. In practice: default mode stays in sprites; dense stress views use squares. Real stress battle, paused: FX on 349 vs off 373 FPS (uncapped), same as previous steps.
- Open point: blood pools were sized for squares and look large next to sprites at close zoom.

### 7. "Building simulation" loading screen
- `src/ui/LoadingScreen.ts` + `#loading-overlay` in `index.html`. Pressing Start shows a full-screen overlay for 3.5 s: "Building simulation", a Knight and a Lion walking toward each other (CSS sprite animation from the same sprite sheets), step messages (Generating terrain → Deploying warriors → Preparing berserker waves → Calculating paths → Ready), a progress bar, then a 0.4 s fade-out. "click to skip" ends it early.
- The run is set up immediately and paused before its first frame, so no sim time passes behind the overlay. Keyboard shortcuts are ignored while it is shown (Space would unpause, R would restart). The overlay also blocks clicks on the control bar.
- Restart (R / Restart button) skips the screen.
- Animation is disabled for `prefers-reduced-motion`.
- Verified: overlay shown; sim time stays 0 s and Space/R/+ are ignored during loading; battle starts after the fade; click skips; works for default and stress mode and for a second Start from the menu; R restart shows no overlay; no console errors.
- Found, not changed (pre-existing): stress mode spawns 2200 warriors (default 300 + 1900 extra in `StateManager`), while the menu says 2000.

### 8. Wrap-up
- README: effects described, FX button added to the controls table, sprite credits.
- Final comparison against the pre-UI code (`5a96495`), served side by side, stress mode, first ~15 s of battle, uncapped headless Chrome:

| Version | Running FPS (avg of runs) | Paused, render only |
|---|---|---|
| Pre-UI (`5a96495`) | ~49 (5 runs) | ~378 |
| Final, FX on | ~53 (4 runs) | ~382 |

  Same within run-to-run noise. Later in a heavy battle, when effects accumulate, effects cost ~0.2–0.3 ms per frame (step 3). Sprites are capped at ~0.7 ms worst case by the sprite budget (step 6).

## Versions

| Tag | Step |
|---|---|
| `v1.1-ui-infra` | 0. Infrastructure |
| `v1.2-ui-hit-flash` | 1. Hit flash |
| `v1.3-ui-death` | 2. Death animation |
| `v1.3.1-ui-death-tilt` | 2.1 Tilted corpses |
| `v1.4-ui-blood` | 3. Light blood |
| `v1.5-ui-status-icons` | 4. Status icons |
| `v1.6-ui-hero-aura` | 5. Hero aura |
| `v1.7-ui-sprites` | 6. Sprites |
| `v1.8-ui-loading-screen` | 7. Loading screen |
| `v1.9-ui-wrap-up` | 8. Wrap-up |

## Open points
- Blood pools look large next to sprites at close zoom (sized for squares).
- The red circle shown for a selected hero uses `hero.sight` (15 tiles) but its code comment calls it the influence area; the aura shows the real charisma radius (10 tiles).
- Stress mode spawns 2200 warriors while the menu says 2000 (pre-existing).

## Out of scope
- Screen shake (rejected).
