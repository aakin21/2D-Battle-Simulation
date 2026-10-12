# src/ui

| File | Role |
|---|---|
| `UIController.ts` | Main menu (Default / Custom / Stress / Battle, map choice, who commands each side, AI timing), top-bar buttons, keyboard and mouse actions, tooltip, saved settings, canvas size, attaching AI controllers |
| `Hud.ts` | What is shown around the map: match banner (top bar), armies (side panel), selected-unit card, area counts, match result |
| `AiPanel.ts` | The AI panels in the side panel, below Map, Armies and Area (scroll down): one for each side with AI layers; with two AI sides the side panel gets two columns (Map and Armies side by side, Area across, West and East side by side), one column below 1300 px. Each shows when the LLM and Jev last answered and when they ask next, the LLM's stance, plan and situation, then a block per hero with a line per layer: the order running now and whose it is (the LLM's, Jev agreeing, or Jev overriding the LLM with a different order, outlined), the LLM's latest order with its reason (D41), Jev's latest choice with its assessment, and the hero's HP, soldiers, state and place. LLM text is escaped before it is shown |
| `AiRequestLog.ts` | Each AI panel's "Requests and answers" list (one per side): every request to Jev and the LLM with its answer, newest first; the line shows the answer (Jev: choice and confidence per hero; LLM: stance and orders), opening it shows the options offered, assessments, plan and orders, and the raw request, answer and rulebook. Entries are added in place and built only when opened |
| `MatchLog.ts` | Match log for experiments (Q11): settings, code version, result, a timeline of both armies per simulation second, every AI decision, and every request with its answer (Jev's game rules kept once); downloaded as JSON (Log button, match result) |
| `Sound.ts` | Sound effects (Web Audio, the pack's sounds): combat sounds for hits and deaths on screen, order and button sounds, start and end jingles; cooldowns, a voice limit and pitch variation; mute saved per browser |
| `icons.ts` | Pixel icons (8×8 grids shown as SVG) for the top-bar buttons |
| `theme.css`, `layout.css` | Theme in the Ninja Adventure style (wooden 9-patch frames, buttons, pixel font; CC0, `src/assets/ui/`) and the page layout |
| `InputHandler.ts` | Mouse and keyboard events (click, drag, scroll, shortcuts) |
| `LoadingScreen.ts` | "Building simulation" overlay after Start; the run stays paused behind it and shortcuts are ignored while it is shown |

## Conventions

- Hero orders from the user go through `engine.issueCommand(hero, command, 'user')`; right-click commands the selected friendly hero (or the first one), and only heroes the user controls (never AI heroes in Agent vs Agent).
- After every `engine.restart()`, call `startControllers()`: restart clears the AI layers.
- Settings saved in local storage are per-browser conveniences only (speed, debug, effects); reads and writes are wrapped in try/catch, since storage can be unavailable.
- Game shortcuts (Space, +/−, R) are ignored while the menu, the Controls screen or the loading screen is shown; Esc opens the menu, and Continue goes back to the run (it resumes only if it was running). Keys with Cmd or Ctrl are left to the browser (reload, page zoom), and a held key acts once, except +/−.
- A run stopped by a simulation error (`engine.setOnError`) shows a "Simulation stopped" card in place of the result; it cannot be resumed, only restarted, and the match log records the error.
- A saved map that is missing or cannot be read stops Start with a message (it is never replaced by a random map), and saving under an existing name asks first.
- New menu options become fields of `SimConfig` (`src/types/types.ts`) rather than state kept in the UI.
