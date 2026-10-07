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
- Blood pools were sized for squares and looked large next to sprites; halved on 2026-10-03 (radii 0.9/0.6 → 0.45/0.3 of the unit side). They now mostly sit under the corpse and show as a thin red rim.

### 6.1 Sprite budget removed (2026-10-03)
- The 800-unit sprite budget was removed at the author's request; the zoom threshold (≥ 9 px/tile) stays. Close-up views now always show sprites, also when crowded in stress mode.
- Measured before deciding (headless Chrome, uncapped, sim running, 3 runs each), comparing the current version with *no budget and no zoom threshold, icons at every zoom*:
  - Default (300 units): ~3056 → ~2186 FPS (−28.5%; 0.33 → 0.46 ms per frame; both far above the display refresh rate, so not visible).
  - Stress (4200 units): ~66 → ~55 FPS (−16%; ~15 → ~18 ms per frame; visible).
- Why sprites cost more than squares: `fillRect` fills one color; `drawImage` samples a texture per pixel, blends transparent pixels and has more per-call overhead (~1.1 µs vs ~0.3 µs per unit). Which frame is drawn (walk, attack) makes no difference.
- Lowering the zoom threshold (sprites from further away) is postponed; revisit together with the stress-mode cost.

### 6.2 Sprites and icons at every zoom (2026-10-03)
- The zoom threshold was removed too, at the author's request: with FX on, units are sprites and status icons are shown at every zoom, including the full-map view (units 10 px).
- Icons scale with the unit (1.4 × zoom, 7–30 px), so they do not dwarf units when zoomed out.
- Cost (measured in 6.1): default mode not visible (~0.13 ms more per frame); stress mode ~16% lower FPS than with squares. Blood pools and the layer are unchanged.

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

## Phase 2 UI: Ninja Adventure style (2026-10-07)

The author found the interface plain and asked for a nicer UI and animations, based on what similar games do. Chosen with the author: the asset pack's own pixel style for menus, HUD and terrain, sound effects that can be switched off, and an on-screen AI panel with a downloadable match log. Same rules as above: rendering only, FX switches the battlefield art off, FPS measured before and after.

References used: game-feel and "juice" practice (easing, squash and stretch, particles; screen shake stays rejected, hit-stop left out because it would touch simulation timing), RTS HUD practice (information in one or two places, primary information always visible, bars that do not clutter big battles), top-down pixel-art practice (one-pixel walk bob, drop shadows, one consistent art style).

| # | Step | Status |
|---|---|---|
| U1 | Theme, full-window layout, HUD, menu | ✅ |
| U2 | AI panel and match log | ✅ |
| U3 | Terrain art from the pack's tilesets | ✅ |
| U4 | Unit animation | ✅ |
| U5 | Sound | |

### U1. Theme, layout, HUD, menu
- Theme from the pack (`src/ui/theme.css`): wooden 9-patch panels and buttons, tabs, slider and the pack's pixel font, drawn at 2x/3x with nearest-neighbour scaling. The font's space is very narrow, so text uses extra word spacing.
- The battlefield canvas fills the window (`Renderer.resize()`); the smallest zoom fits the whole map and centres it. Top bar with pixel icons, a match banner (points and control-point flags, base HP or units, time left in red under 30 s), and a side panel with the minimap (2x, with control points, bases and heroes), both armies (soldiers, total HP, each hero's HP and flight/rest) and area counts.
- Selected-unit card with the unit's sprite as a portrait, HP, courage, state and the hero's current order and its source.
- Menu as one card; LLM model rows and AI timing only appear when an LLM or any AI is chosen. Controls screen with the pack's key and mouse icons. Match result card with both sides' units, heroes, HP left and points or base HP.
- Fixed on the way: Space behind the open menu unpaused the run; the menu had no way back to the running match (now Continue and Esc); R during a stress test restarted it as a Default game; a drawn match was described as "more points"; the loading screen talked about berserker waves in battle mode.
- Cost: render time per frame measured in the browser (stress mode, 4,062 units, 100 renders): FX on 2.06 ms at 1140×836 vs 2.13 ms at 750×750; FX off 1.12 vs 1.13 ms. The larger canvas does not change the cost of drawing.

### U2. AI panel and match log
- AI section in the side panel (battle with an AI side): the LLM's stance, plan, valid orders and rejected-order count, Jev's latest choice per hero with its confidence and threat score, time since the last answer, response times, skipped requests, "thinking…" while a request is open, and why a layer stopped. LLM text is escaped before it is shown.
- Match log (Log button in the Armies header, "Download log" on the result card): JSON with the code version (`git describe`, built in by Vite), settings, result, a timeline of both armies per simulation second (soldiers, heroes, HP, fleeing, points or base HP) and every LLM and Jev decision with its response time, plus each layer's failure and the LLM rulebook. Replaces copying `ai.*.decisions` from the console during live tests.
- Tested in the browser with fake LLM and Jev answers (no real AI calls): panel contents, an HTML tag in the LLM plan shown as text, an LLM failing with HTTP 500 (panel shows it, its heroes switch to rules), and the downloaded JSON (33 samples, 3 LLM and 36 Jev decisions, failure reason, 5,800-character rulebook).

### U3. Terrain art
- `TerrainArt.ts` builds the battlefield from the pack's tilesets once per map: lime grass for open ground, darker grass under forests, the pack's water recoloured to murky green for swamps, its dark earth recoloured to grey-green rock for mountains. 8 art pixels per tile, the same pixel size as the unit sprites (16 px over 2 tiles).
- Edges follow the simulation's tiles: each pixel takes the terrain with the largest bilinear weight of the four nearest tile centres, plus value noise (±0.18), so an edge moves at most ~1.5 px from the real tile edge and corners are rounded. A one-pixel outline marks where a terrain meets a lower one; swamps also get a light rim.
- Decorations only where every tile under them matches: overlapping trees and bushes in forests, rock groups and single rocks (brown and blue rocks recoloured to the grey palette) on mountains, reeds and lily pads in swamps, a few flowers and tufts on open ground. Positions come from a hash of the tile, never from `Math.random`, so a map always looks the same and no simulation randomness is used.
- `ObjectiveArt.ts`: control points get a waving flag in the holder's colour (white when nobody holds it) and a dashed ring; bases are towers (west wooden, east stone) that show damage below 50% HP and ruins at 0.
- The art is drawn smoothed when shown smaller than its own pixels (the full-map view) and sharp when magnified. The minimap shrinks the same art. FX off shows the original flat colours, also on the minimap.
- Cost: building the art takes 40–60 ms per map (behind the loading screen). Render time per frame, stress mode with ~4,100 units: FX on 2.07 ms with the art vs 2.06 ms before it; with a GPU sync after every frame (1-pixel readback) 11.44 ms with the art vs 11.24 ms with flat colours.
- Seen in the browser: image decoding waits while the page is hidden (a hidden tab or preview pane); until then the terrain stays flat and units stay squares, and the art appears as soon as the page is visible.

### U4. Unit animation
- Drop shadows under every living unit, baked into the sprite sheets (3-pixel ellipse, 30% black): no cost per frame.
- Attack pose leans 12% of the sprite's size toward the facing side, so a hit reads as a lunge.
- `effects/Bursts.ts`: the pack's curved slash where a unit is hit (0.24 s) and its smoke puff where one dies (0.5 s). Pooled (240 slashes, 160 puffs), at most 40 slashes and 20 puffs started per update, a pre-mirrored slash sheet instead of per-hit transforms, culled outside the view.
- Flee and rest icons are the pack's alarm and sleep emotes (glyphs until they load), drawn sharp.
- Hero orders: a bobbing marker in the side's colour at the task point, a ring that closes on a new task point when any order arrives (user, rules, Jev or LLM), and a dashed line from the selected hero to its target. FX off keeps the original X.
- Camera: the mouse wheel zooms with easing around the cursor (steps add up), a minimap click glides to the spot; dragging stays direct. `prefers-reduced-motion` turns easing and marker motion off.
- Bars: with FX on, HP and courage bars only over units that are hurt, fighting, fleeing or resting, over heroes and the selected unit (Bars button: every unit). Fewer bars is the main clutter fix for big battles.
- Narrow windows: below 1000 px the match banner moves to its own row in the top bar.
- Cost (render time per frame, stress mode, 1440×900 window): before the armies meet (20 s, 4,201 units) FX on 1.41 ms with smart bars vs 2.23 ms with all bars, FX off 1.20 ms; in the battle (57 s, 4,075 units, up to 58 bursts at once) 1.65 ms smart vs 2.40 ms all bars; zoomed on the front 0.61 ms vs 0.30 ms with FX off.

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
| `v1.9.1-ui-no-sprite-budget` | 6.1 Sprite budget removed |
| `v1.9.2-ui-sprites-all-zoom` | 6.2 Sprites and icons at every zoom |
| `v1.9.3-ui-smaller-blood` | Blood pools halved |
| `v1.12-ui-label-fixes` | Hero sight circle naming, stress menu count |

## Open points
- None. Resolved 2026-10-03 (`v1.12-ui-label-fixes`): the red circle around a selected hero is its sight range (15 tiles), now named and commented as such; the charisma radius (10 tiles) is shown by the hero aura. The stress menu now says 2200 warriors, which is what stress mode spawns (300 default + 1,900).

## Out of scope
- Screen shake (rejected).
