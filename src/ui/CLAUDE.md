# src/ui

| File | Role |
|---|---|
| `UIController.ts` | Ties the UI together: Start (from the menu's settings), Continue, opening and closing the menu, restart, the top bar's run buttons (pause, speed, restart, menu, save map, Controls, Log), keyboard shortcuts, sound wiring, canvas size, match result and error, attaching AI controllers (`startControllers()`), the 100 ms refresh |
| `ViewToggles.ts` | The top bar's view toggles (FX, Bars, Sound, Debug) and the settings saved with them and the speed (`Settings.ts`): applied at page load, saved on every change |
| `MainMenu.ts` | The main menu's settings: tabs (Default / Custom / Stress / Battle), sliders, map choice and saved-map list (saving a map too), who commands each side, LLM provider and model (OpenRouter lists, D52), AI timing. `readStart()` turns them into the run Start sets up (or the stress test), or shows an alert and gives null when they cannot run as chosen |
| `CanvasInteraction.ts` | The mouse on the battlefield: select a unit (left click), order a hero (right click, through `engine.issueCommand(..., 'user')`), tooltip, zoom and pan, area-count rectangle, minimap click; keeps which unit is selected |
| `Settings.ts` | Per-browser settings in local storage (speed, debug, effects, bars, sound): their keys, reading and saving, each wrapped in try/catch |
| `Hud.ts` | What is shown around the map: match banner (top bar), armies (side panel), selected-unit card, area counts, match result |
| `AiPanel.ts` | The AI panels in the side panel, below Map, Armies and Area (scroll down): one for each side with AI layers; with two AI sides the side panel gets two columns (Map and Armies side by side, Area across, West and East side by side), one column below 1300 px. Each shows when the LLM and Jev last answered and when they ask next, the LLM's stance, plan and situation, then a block per hero with a line per layer: the order running now and whose it is (the LLM's, Jev agreeing, or Jev overriding the LLM with a different order, outlined), the LLM's latest order with its reason (D41), Jev's latest choice with its assessment, and the hero's HP, soldiers, state and place. LLM text is escaped before it is shown |
| `Dropdown.ts` | A drop-down list in the menu's pixel style (the browser's `<select>` cannot match it): grouped items, mouse and keyboard, opens upward near the screen's edge. Used for the OpenRouter models (D52) |
| `AiRequestLog.ts` | Each AI panel's "Requests and answers" list (one per side): every request to Jev and the LLM with its answer, newest first; the line shows the answer (Jev: choice and confidence per hero; LLM: stance and orders), opening it shows the options offered, assessments, plan and orders, and the raw request, answer and rulebook. Entries are added in place and built only when opened |
| `format.ts` | Text helpers shared by the HUD, the AI panels, the request log and the menu's drop-down: `escapeHtml`, `clock`, `prettyKey` (AI option keys as text), the UI's `describeCommand` (the AI layers describe orders in their own words) and the side names |
| `MatchLog.ts` | Match log for experiments (Q11): settings, code version, result, a timeline of both armies per simulation second, every AI decision, and every request with its answer (Jev's game rules kept once); downloaded as JSON (Log button, match result) |
| `download.ts` | Saving a file from the page and the match files' names (`match-<objective>-<west>-vs-<east>-<time>`), for the match log and the replay |
| `Sound.ts` | Sound effects (Web Audio, the pack's sounds): combat sounds for hits and deaths on screen, order and button sounds, start and end jingles; cooldowns, a voice limit and pitch variation; mute saved per browser |
| `icons.ts` | Pixel icons (8×8 grids shown as SVG) for the top-bar buttons |
| `theme.css`, `layout.css` | Theme in the Ninja Adventure style (wooden 9-patch frames, buttons, pixel font; CC0, `src/assets/ui/`) and the page layout |
| `InputHandler.ts` | Mouse and keyboard events (click, drag, scroll, shortcuts) |
| `ReplayController.ts` | Replays in the page (`src/replay/`): records battle-mode matches and shows a replay over the live run: Watch replay / Download replay on the match result, Replay next to Log in Armies, Watch a replay in the menu; while one is watched `UIController` sends the top-bar pause, speed and restart to it, right-click orders are off and selection, tooltip and area counts read the replay's units. Exit leaves the live run as it was before the replay (running if it was running), or goes back to the menu when no run was started |
| `LoadingScreen.ts` | "Building simulation" overlay after Start; the run stays paused behind it and shortcuts are ignored while it is shown |

## Conventions

- Hero orders from the user go through `engine.issueCommand(hero, command, 'user')`; right-click commands the selected friendly hero (or the first one), and only heroes the user controls (never AI heroes in Agent vs Agent).
- After every `engine.restart()`, call `UIController.startControllers()`: restart clears the AI layers.
- Settings saved in local storage are per-browser conveniences only (speed, debug, effects, bars, sound); reads and writes are wrapped in try/catch, since storage can be unavailable.
- Game shortcuts (Space, +/−, R) are ignored while the menu, the Controls screen or the loading screen is shown; Esc opens the menu (or closes the Controls screen), and Continue goes back to the run (it resumes only if it was running). While the loading screen is shown every key is ignored, Esc too. While a replay is watched, Space, +/− and R act on the replay. Keys with Cmd or Ctrl are left to the browser (reload, page zoom), and a held key acts once, except +/−.
- A run stopped by a simulation error (`engine.setOnError`) shows a "Simulation stopped" card in place of the result; it cannot be resumed, only restarted, and the match log records the error.
- A saved map that is missing or cannot be read stops Start with a message (it is never replaced by a random map), and saving under an existing name asks first.
- New menu options become fields of `SimConfig` (`src/types/types.ts`) rather than state kept in the UI.
