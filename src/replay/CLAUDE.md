# src/replay

Match replays: record a battle-mode match while it runs, watch it again or save it as a file and open it later from the menu. UI only: nothing here changes the simulation.

| File | Role |
|---|---|
| `Replay.ts` | The replay format: per-unit facts (type, side, max HP, hero index), frames (every living unit's place in tenths of a tile, HP, state, courage; the heroes' task points and orders; control points and bases), the side panels' HTML as it changed. Saved gzip-compressed: a JSON header, then binary columns per frame with positions as changes since the previous frame. `sanitizeHtml` cleans panel HTML read from a file |
| `ReplayRecorder.ts` | Takes a frame 3 times per simulated second (engine `setOnStep`) and the panels whenever their HTML changes (the UI's 100 ms refresh); `finish()` at the match end; `download()` saves the `.replay` file |
| `ReplayPlayer.ts` | Plays a replay: the battlefield at its time for the renderer and minimap (engine `setViewSource`), positions interpolated between frames; puts the panels back; the replay bar (play, speed 0.5–8x, seek, exit) |

## Conventions

- Read the battlefield and the page, never change them; the live run waits paused behind a replay and goes on after Exit.
- Recording is on by default in battle mode (menu: Replay Record / Off, `SimConfig.recordReplay`); classic and stress runs are not recorded.
- A replay file can come from anyone: its panel HTML goes through `sanitizeHtml`, and the format is checked (`format`, `version`, a readable map) before anything is shown.
- The request lists of the AI panels are not part of a replay (they are in the match log).
- Change the format only with a new `REPLAY_VERSION`; older files must still open.
