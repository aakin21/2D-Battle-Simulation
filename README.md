# 2D Battle Simulation

A browser-based simulation of large-scale battlefield behavior. Hundreds of units fight, flee, and regroup autonomously based on morale, terrain, and proximity to allies and enemies.

**Live demo:** https://aakin21.github.io/2D-Battle-Simulation/

---

## What it does

- Warriors follow a hero's task point and engage approaching enemies
- Berserker hordes spawn in waves and push toward the friendly side
- Each unit tracks its own courage — taking heavy losses or being outnumbered causes units to flee and rest before returning to the fight
- The hero boosts the courage of nearby warriors
- Terrain (forest, swamp, mountain) affects movement speed and pathfinding
- Battle mode: two symmetric armies with heroes commanded by the user, rule-based heroes or AI layers (a tactical model and an LLM), with elimination, control-point and base objectives; matches can be recorded and replayed
- Visual effects layer: hit flashes, death animation, light blood, status icons (flee / rest), hero aura, animated unit sprites, and a loading screen. Rendering only — the simulation itself is unaffected, and the FX button switches all of it off
- The simulation runs entirely in the browser; only the AI layers need the dev server (`npm run dev`), which adds the API keys on the server side

## Controls

| Input | Action |
|---|---|
| Right-click | Order the selected hero to a point |
| Left-click | Select unit |
| Drag | Area unit count when zoomed out, pan when zoomed in |
| Shift + drag | Pan camera |
| Scroll | Zoom |
| Space | Pause / resume |
| + / - | Simulation speed |
| R | Restart |
| Esc | Menu (Continue returns to the running match) |
| FX button | Toggle visual effects (off = original squares) |
| Bars button | Bars only where something happens (default) or over every unit |
| Speaker button | Sound on / off |

## Running locally

```bash
npm install
npm run dev
```

Requires Node.js 18+.

## Tech

TypeScript · Vite · HTML5 Canvas · GitHub Pages

## Credits

Unit sprites, terrain tilesets, flags and towers, effects, sounds, the UI theme, key icons and the pixel font: [Ninja Adventure Asset Pack](https://pixel-boy.itch.io/ninja-adventure-asset-pack) by Pixel-boy, released under CC0 (see the `LICENSE.txt` files in `src/assets/`).
