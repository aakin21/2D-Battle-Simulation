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
- Runs entirely in the browser, no server

## Controls

| Input | Action |
|---|---|
| Right-click | Set hero task point |
| Left-click | Select unit |
| Shift + drag | Area unit count |
| Scroll | Zoom |
| Drag | Pan camera |
| Space | Pause / resume |
| + / - | Simulation speed |
| R | Restart |

## Running locally

```bash
npm install
npm run dev
```

Requires Node.js 18+.

## Tech

TypeScript · Vite · HTML5 Canvas · GitHub Pages
