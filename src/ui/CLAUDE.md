# src/ui

| File | Role |
|---|---|
| `UIController.ts` | Main menu (Default / Custom / Stress / Battle, map choice, who commands each side, AI timing), control bar, info panel, tooltip, saved settings, match result, attaching AI controllers |
| `InputHandler.ts` | Mouse and keyboard events (click, drag, scroll, shortcuts) |
| `LoadingScreen.ts` | "Building simulation" overlay after Start; the run stays paused behind it and shortcuts are ignored while it is shown |

## Conventions

- Hero orders from the user go through `engine.issueCommand(hero, command, 'user')`; right-click commands the selected friendly hero (or the first one), and only heroes the user controls (never AI heroes in Agent vs Agent).
- After every `engine.restart()`, call `startControllers()`: restart clears the AI layers.
- Settings saved in local storage are per-browser conveniences only (speed, debug, effects).
- New menu options become fields of `SimConfig` (`src/types/types.ts`) rather than state kept in the UI.
