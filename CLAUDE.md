# Project instructions

This is a thesis project. Phase 1 (baseline simulation, commit `5a96495`) is a finished checkpoint; Phase 2 adds AI integration (see `THESIS_DOCUMENTATION.md`).

## Architecture

Browser app (TypeScript + Vite + Canvas). The main folders have their own `CLAUDE.md` with details.

| Folder | Role |
|---|---|
| `src/engine/` | Simulation: rules, courage, movement, combat, hero commands, match end |
| `src/ai/` | AI layers that command heroes: Jev or SubQ Snap (tactical, layer 2, D51) and the LLM (strategic, layer 3) |
| `src/state/` | Battlefield data, spawning, unit lookup, saved maps |
| `src/rendering/` | Canvas drawing, minimap, visual effects |
| `src/ui/` | The front end (title screen over a recorded battle, Match setup, Sandbox, AI connections), pause menu, in-context hints, controls, mouse and keyboard input |
| `src/types/` | Shared types and constants |
| `src/maps/` | The fixed map (D5) |
| `src/assets/` | Unit sprite sheets (CC0, D25) |
| `src/replay/` | Match replays: record a battle, watch it again, save and open `.replay` files, play a replay the site ships (UI only) |
| `public/` | Static files served as they are: `replays/`, the replays shipped for the title screen's Watch a recorded battle (`index.json` lists them; empty until recorded with the real AIs), and `attract/battle.replay`, the title screen's background battle (rule heroes on both sides, recorded headless by `../tests/smoke/attract-record.ts`; not listed to watch) |
| `server/` | Node only: the LLM endpoint (`/api/llm`) and the access guard for `/api/*` (D37), mounted by the dev server and by the AI bridge (`npm run bridge`), which serves the LLM endpoint alone on the player's computer for the published demo |
| `api/` | Vercel functions for the deployed site: the Jev proxy (`/api/jev`, D8) |
| `proxy/` | Cloudflare Worker for the published demo (not deployed by the repository; `proxy/README.md`): the tactical layer's proxy on the author's keys (`POST /api/jev`, `POST /api/snap`, `GET /api/tactical`), each visitor's address 2 matches a UTC day, counted in a Durable Object per salted address hash; own `tsconfig.json`, tests in `../tests/smoke/tacticalproxy.ts` |
| `experiments/` | The headless experiment runner (`npm run experiment -- <plan>`, `npm run experiment:analyse -- <folder>`): plays a plan's matches in Node with the real engine and AI layers against an AI server, writes a match log per match and a summary; `experiments/README.md` |

The three decision layers (D1): rules every simulation step (`src/engine`; a fixed step of 1/60 s, a higher speed runs more steps per frame, P9), Jev every ~4 s, LLM every ~15 s (D50, `src/ai`).

## Rules that must not be broken

- **Every hero order goes through the command interface** (D20): user clicks, Jev and the LLM call `SimulationEngine.issueCommand`; rule heroes (`src/engine/RuleHeroes.ts`) call the same `HeroCommands.issue` inside the engine. Never set `hero.taskPoint` or `hero.command` directly (only `ReplayPlayer` does, on its own copies of a replay's units).
- **Courage is computed only by the engine** (D14). No command or AI layer may change courage or force a fleeing unit to fight.
- **The rule layer's reflexes come first** (D18, D34): a hero's survival reflex overrides rule-layer orders; only a different order from the user, Jev or the LLM can end a flight. Fleeing soldiers can never be ordered back (D14).
- **Classic mode keeps Phase 1 behavior** (D19). Battle-mode changes must be guarded by battle mode.
- **AI layers only see what their decision needs** (D16): Jev gets a hero's surroundings, the LLM gets the whole map.
- **API keys never reach the browser** (D7). Keys live in `.env.local` (not committed) and are added server-side.

## Running

- `npm run dev`: the full app, including the Jev and SubQ Snap proxies (`/api/jev`, `/api/snap`) and the LLM endpoint (`/api/llm`).
- `npm run build`: static build. On Vercel, `api/jev.ts` serves `/api/jev` (key in the Vercel project's `TYPESAFE_API_KEY`); the LLM is not available there until the Claude API is used (D10).
- AI in the online demo (D37): set `AI_PASSWORD=...` in `.env.local`, run `npm run dev` and a tunnel (`cloudflared tunnel --url http://localhost:5173` or `ngrok http 5173`), then open the demo once with `?ai=<tunnel address>&key=<AI_PASSWORD>`. Requests from localhost need no password; `AI_ALLOWED_ORIGINS` overrides the allowed demo origin (default `https://aakin21.github.io`).
- Jev needs `TYPESAFE_API_KEY=...` in `.env.local`, SubQ Snap (D51) `SUBQ_API_KEY=...`, and an LLM run through OpenRouter (a model `openrouter:<id>`, D52) `OPENROUTER_API_KEY=...`. The LLM uses the developer's Claude login through the Agent SDK; the model is chosen per side in Match setup (the AI server's Haiku / Sonnet / Opus, pinned to the 5.5 generation, D44; `LLM_MODEL` only sets the server default; `LLM_MAX_BUDGET_USD`, 5 by default, caps one LLM session's estimated spend).
- A local model (`local:<name>`, Match setup: the AI server's "A model by name…") needs an OpenAI-compatible chat server at `LOCAL_LLM_URL` (default Ollama's `http://localhost:11434/v1`); optional: `LOCAL_LLM_KEY` (its key) and `LOCAL_LLM_HISTORY_TURNS` (earlier reports and answers sent again, default 3). Ollama's default context window may be too small for the rulebook and a report (~6k tokens, an estimate): raise it, e.g. `OLLAMA_CONTEXT_LENGTH=16384 ollama serve` (a note to verify, not measured). See `server/CLAUDE.md`.
- AI bridge (the published demo with the player's own model, `server/bridge.ts`): `npm run bridge` builds `dist-bridge/ai-bridge.mjs` (one file, runs with plain `node` anywhere; not committed) and starts it on `http://127.0.0.1:8642` (`--port <n>` or `BRIDGE_PORT`); `npx <site>/ai-bridge.tgz` (packed by `npm run build`) starts the same with the Claude Agent SDK installed by npx, and opens the demo with the bridge's address (`?ai=http://127.0.0.1:<port>`; `--no-open` or `BRIDGE_OPEN=0` do not). The page connects a bridge it has the address of at load when the browser's permission is granted (or it has no such permission), otherwise with one Connect click (the browser then asks once); on the published page the bridge is a quiet "Or use your own computer" line under the OpenRouter card until a bridge is in play. It reads `LOCAL_LLM_*`, `LLM_MODEL`, `LLM_MAX_BUDGET_USD`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `CODEX_API_KEY` / `OPENAI_API_KEY` / `CODEX_PATH`, `CLI_*` and `AI_ALLOWED_ORIGINS` from the environment and `.env.local` in the working folder. Claude models run there through the Agent SDK on the player's Claude Code sign-in, or with `ANTHROPIC_API_KEY` when set (2026-11-22; Anthropic's documentation asks third-party products for API keys: the README says so); Jev and Snap are not served (404; Match setup refuses them at Start). `npm run bridge:build` builds the file only. See `server/CLAUDE.md`.
- Codex and Gemini as sessions, like Claude (2026-11-22, dev server and bridge): `codex` / `codex:<model>` runs OpenAI's Codex through the Codex CLI installed on the computer (`codex` on PATH or `CODEX_PATH`; no SDK, nothing to install with the repository or the bridge) on its Codex sign-in; `gemini:<model>` runs Gemini through the Interactions API with `GEMINI_API_KEY`. A command of one's own: `CLI_TOOL_<NAME>=<command>` makes `cli:<name>` (run once per report, the last `CLI_HISTORY_TURNS` turns sent again; `CLI_TOOLS=off` turns them off). See `server/CLAUDE.md`.
- Formatting: Prettier (`.prettierrc`; `npm run format` / `npm run format:check` cover src, server, api and `vite.config.ts`; Markdown is not formatted, `.prettierignore`); lint: `npm run lint` (src, server, api and `vite.config.ts`); types: `npm run typecheck` (the browser code and, through `tsconfig.node.json`, the Node code). Run them on files you change.
- Smoke tests (D24) live outside the repo in `../tests/smoke/` (`./run-all.sh`, `README.md`): headless, fake AIs only. They run the browser's own steps (`engine.step()`, 1/60 s), so a seeded headless battle is the battle the browser plays. `same.ts` hashes the battlefield, so diffing its output before and after a change shows the simulation is unchanged; `prompts.ts` prints everything the AI layers are sent, so the same diff shows the prompts are unchanged; `drawlog.ts` logs what the main view and the minimap draw, so it shows a rendering change draws the same. `run-all.sh` compares all three with the saved base outputs (`out/*-main.txt`).

## Thesis documentation rule

`THESIS_DOCUMENTATION.md` is the record of the thesis process. Do not update it while a topic is still being discussed. Discuss first; write entries only when the user asks or confirms (e.g. "bunu kaydet"), or at the end of a topic after asking the user.

Record an entry when:
- **A decision is proposed or changes status:** a proposal is put forward, or the user explicitly accepts or rejects one. → Decision log (`D#`)
- **Research is done:** a question is investigated (docs, web, API tests, experiments, benchmarks). → Research log (`R#`)
- **A thesis-level problem is encountered:** something blocks the plan, an assumption turns out wrong, or a limitation forces a design change. → Problems log (`P#`)
- **A question is raised or answered.** → Open questions (`Q#`): add it, or update its notes and point to the decision that answered it.
- **A milestone is reached.** → Timeline

What NOT to record: small implementation issues: ordinary bugs, typos, minor algorithm tweaks, refactors, tuning a constant. Record only what matters at thesis level: decisions about the design or the research direction, research results, and problems that change the plan or the architecture or are worth discussing in the thesis. When unsure, ask the user instead of logging.

Decision status: a decision is `Accepted` only when the user explicitly confirms it. Proposals from the professor or from Claude, and options under discussion, are `Proposed`.

How to write entries:
- Follow the `thesis-log` skill (`.claude/skills/thesis-log/SKILL.md`) for each section's format.
- IDs are sequential and never reused. Never delete an entry: superseded decisions get status `Superseded by D#`, resolved problems get status `Resolved`.
- Use absolute dates (YYYY-MM-DD). Cross-reference related entries (`see R1`, `D7`).
- Write the documentation in English. Discussion with the user is in Turkish.
- Record facts as they happened, with sources for research. Mark vendor claims or unverified numbers as such.
- After updating, tell the user in one line what was logged (e.g. "Logged: D8 accepted, P1 resolved").
