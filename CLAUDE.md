# Project instructions

This is a thesis project. Phase 1 (baseline simulation, commit `5a96495`) is a finished checkpoint; Phase 2 adds AI integration (see `THESIS_DOCUMENTATION.md`).

## Architecture

Browser app (TypeScript + Vite + Canvas). Each folder has its own `CLAUDE.md` with details.

| Folder | Role |
|---|---|
| `src/engine/` | Simulation: rules, courage, movement, combat, hero commands, match end |
| `src/ai/` | AI layers that command heroes: Jev (tactical, layer 2) and the LLM (strategic, layer 3) |
| `src/state/` | Battlefield data, spawning, unit lookup, saved maps |
| `src/rendering/` | Canvas drawing, minimap, visual effects |
| `src/ui/` | Menu, controls, mouse and keyboard input |
| `src/types/` | Shared types and constants |
| `src/maps/` | The fixed map (D5) |
| `src/assets/` | Unit sprite sheets (CC0, D25) |
| `server/` | Dev-server only: the LLM endpoint (`/api/llm`) |
| `api/` | Vercel functions for the deployed site: the Jev proxy (`/api/jev`, D8) |

The three decision layers (D1): rules every frame (`src/engine`), Jev every ~4 s, LLM every ~20 s (`src/ai`).

## Rules that must not be broken

- **Every hero order goes through `SimulationEngine.issueCommand`** (D20): user clicks, rule heroes, Jev and the LLM alike. Never set `hero.taskPoint` or `hero.command` directly.
- **Courage is computed only by the engine** (D14). No command or AI layer may change courage or force a fleeing unit to fight.
- **The rule layer's reflexes come first** (D18, D34): a hero's survival reflex overrides rule-layer orders; only a different order from the user, Jev or the LLM can end a flight. Fleeing soldiers can never be ordered back (D14).
- **Classic mode keeps Phase 1 behavior** (D19). Battle-mode changes must be guarded by battle mode.
- **AI layers only see what their decision needs** (D16): Jev gets a hero's surroundings, the LLM gets the whole map.
- **API keys never reach the browser** (D7). Keys live in `.env.local` (not committed) and are added server-side.

## Running

- `npm run dev`: the full app, including the Jev proxy and the LLM endpoint.
- `npm run build`: static build. On Vercel, `api/jev.ts` serves `/api/jev` (key in the Vercel project's `TYPESAFE_API_KEY`); the LLM is not available there until the Claude API is used (D10).
- Jev needs `TYPESAFE_API_KEY=...` in `.env.local`. The LLM uses the developer's Claude login through the Agent SDK; the model is chosen per side in the Battle menu (Haiku / Sonnet / Opus; `LLM_MODEL` only sets the server default).
- Formatting: Prettier (`.prettierrc`); lint: `npm run lint`. Run both on files you change.

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
