# src/ui

| File | Role |
|---|---|
| `UIController.ts` | Main menu (Default / Custom / Stress / Battle, map choice, who commands each side, AI timing), top-bar buttons, keyboard and mouse actions, tooltip, saved settings, canvas size, attaching AI controllers |
| `Hud.ts` | What is shown around the map: match banner (top bar), armies (side panel), selected-unit card, area counts, match result |
| `icons.ts` | Pixel icons (8×8 grids shown as SVG) for the top-bar buttons |
| `theme.css`, `layout.css` | Theme in the Ninja Adventure style (wooden 9-patch frames, buttons, pixel font; CC0, `src/assets/ui/`) and the page layout |
| `InputHandler.ts` | Mouse and keyboard events (click, drag, scroll, shortcuts) |
| `LoadingScreen.ts` | "Building simulation" overlay after Start; the run stays paused behind it and shortcuts are ignored while it is shown |

## Conventions

- Hero orders from the user go through `engine.issueCommand(hero, command, 'user')`; right-click commands the selected friendly hero (or the first one), and only heroes the user controls (never AI heroes in Agent vs Agent).
- After every `engine.restart()`, call `startControllers()`: restart clears the AI layers.
- Settings saved in local storage are per-browser conveniences only (speed, debug, effects); reads and writes are wrapped in try/catch, since storage can be unavailable.
- Game shortcuts (Space, +/−, R) are ignored while the menu, the Controls screen or the loading screen is shown; Esc opens the menu, and Continue goes back to the run (it resumes only if it was running).
- New menu options become fields of `SimConfig` (`src/types/types.ts`) rather than state kept in the UI.
