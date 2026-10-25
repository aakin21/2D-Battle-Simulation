# src/replay

Match replays: record a battle-mode match while it runs, watch it again or save it as a file and open it later from the menu. UI only: nothing here changes the simulation.

| File | Role |
|---|---|
| `Replay.ts` | The replay format (and `PANEL_SELECTORS`, the page elements whose HTML is kept): per-unit facts (type, side, max HP, hero index), frames (every living unit's place in tenths of a tile, HP, state, courage; the heroes' task points and orders; control points and bases), the side panels' HTML as it changed. Saved gzip-compressed: a JSON header, then binary columns per frame with positions as changes since the previous frame. `sanitizeHtml` rebuilds panel HTML read from a file from an allowlist |
| `ReplayRecorder.ts` | Takes a frame 3 times per simulated second (engine `setOnStep`) and the panels whenever their HTML changes (the UI's 100 ms refresh); `finish()` at the match end; `download()` saves the `.replay` file (`src/ui/download.ts`) |
| `ReplayPlayer.ts` | Plays a replay: the battlefield at its time for the renderer and minimap (engine `setViewSource`), positions interpolated between frames; puts the panels back; the replay bar (play, speed 0.5–8x, seek, exit) |

## Conventions

- Read the battlefield and the page, never change them; the live run waits paused behind a replay and goes on after Exit.
- Recording is on by default in battle mode (menu: Replay Record / Off, `SimConfig.recordReplay`); classic and stress runs are not recorded.
- A replay file can come from anyone: its panel HTML goes through `sanitizeHtml`, and the format is checked before anything is shown; a damaged file is refused with a message, never accepted and then broken while drawing. Checked: `format`, `version` (an integer from 1 to `REPLAY_VERSION`), JSON that parses, a readable map, every unit's facts (id, type, side, max HP, sight, charisma radius, hero index), the objective's points and bases, frame times (finite, in order), every frame's heroes (index, task point, order) and objective, every unit index in range. A file that unpacks to over 200 MB is refused while it is read.
- `sanitizeHtml` is an allowlist: it parses the HTML inertly and builds a new tree in a `<template>` with only the elements the panels use (div, span, i, b, em, strong, small, br, h2, h3, table rows and cells), their `class`, `title`, `hidden`, `aria-hidden`, `colspan`/`rowspan` and `data-*` attributes, and inline styles of a few properties with plain values (bar widths and colours). Everything else is dropped with its content: scripts, links, images, media, frames, forms, SVG and MathML, and raw-text elements such as noscript, xmp or noembed (mXSS). A new element or attribute in a panel must be added there, or it is missing from replays.
- Unit facts from a replay reach the UI (tooltip, selected-unit card): they are escaped there too, and a replay is shown with battle labels even over a classic run.
- The request lists of the AI panels are not part of a replay (they are in the match log).
- Change the format only with a new `REPLAY_VERSION`; older files must still open.
