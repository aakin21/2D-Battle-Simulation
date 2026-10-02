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
| 1 | Hit flash | ⬜ |
| 2 | Death animation | ⬜ |
| 3 | Light blood | ⬜ |
| 4 | Status icons | ⬜ |
| 5 | Hero aura | ⬜ |
| 6 | Sprites | ⬜ |
| 7 | "Building simulation" loading screen | ⬜ |
| 8 | Wrap-up | ⬜ |

### 0. Infrastructure
- `src/rendering/effects/EffectsManager.ts`: frame-diff event detection (hits, deaths, facing), keyed by unit id.
- `src/rendering/effects/Pool.ts`: fixed-capacity `Pool` (particles) and `RingBuffer` (decals); no allocation in the frame loop.
- "FX: On/Off" button in the control bar (instead of the config screen, so it can be toggled mid-run for FPS comparison), persisted in localStorage.
- Debug overlay shows cumulative FX hit/death counts.
- `BerserkerPool` assigns a new id on reuse, so id-keyed diffing is safe. Unit ids restart from 0 on every run, so effects reset on restart (and auto-reset if sim time goes backwards).
- Verified: pause freezes events; restart and FX re-enable produce no fake death burst; FX setting survives reload; stress mode (4199 units) 60 FPS with FX on and off.

### 1. Hit flash
- A unit that takes damage renders white for ~80 ms.

### 2. Death animation
- The unit fades out over ~0.4 s; a small corpse mark stays for a few seconds.

### 3. Light blood
- 2–3 small red particles on hit.
- A small dark decal on death, fading over 20–30 s.
- Decals kept in a ring buffer (max ~1500); only visible ones are drawn.

### 4. Status icons
- "!" above units in FLEE, "z" above units in REST.
- Shown only above a zoom threshold.

### 5. Hero aura
- A subtle pulsing ring at the charisma radius, always visible.
- The existing filled circle when the hero is selected is kept.

### 6. Sprites
- CC0 pixel art pack (Kenney or itch.io); license credited in README.
- Single sprite atlas.
- Warrior / berserker / hero with walk and attack frames; attack moment derived from `attackCooldown`; facing from movement direction.
- LOD: below a zoom threshold, units are still drawn as squares.

### 7. "Building simulation" loading screen
- Pressing Start shows a 3–5 s overlay.
- Step messages ("Generating terrain…", "Deploying warriors…", "Calculating paths…"), a progress bar, and a small animation.
- Real setup happens behind it while the simulation stays paused; the battle starts when the overlay fades out.
- Restart (R) skips the screen to stay fast.

### 8. Wrap-up
- FPS measurement in 2000 vs 2000 mode with effects on and off.
- Add the effects toggle to the README.

## Out of scope
- Screen shake (rejected).
