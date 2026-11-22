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

Requires Node.js 18+. Open the address Vite prints (http://localhost:5173 by default). The simulation runs without any keys. The AI layers read their keys from a `.env.local` file in the project folder (not committed; the keys stay on the dev server): `TYPESAFE_API_KEY` for Jev, `SUBQ_API_KEY` for SubQ Snap, `OPENROUTER_API_KEY` for LLMs through OpenRouter. The Claude LLM uses the developer's Claude login instead of a key; `LLM_MAX_BUDGET_USD` (5 by default) caps one LLM session's estimated spend.

`npm run build` makes the static site (`dist/`). Checks: `npm run typecheck`, `npm run lint`, `npm run format:check`.

## Play the online demo with your own model

The live demo runs the battle in your browser; its AI commander (the LLM) can run on [OpenRouter](https://openrouter.ai) with your own account (press **Connect** on the title screen), or on what you have on your own computer. For that, run this in a terminal (Node.js 20.12 or newer):

```bash
npx https://aakin21.github.io/2D-Battle-Simulation/ai-bridge.tgz
```

It starts the AI bridge, a small program that connects the demo to what you have on your computer, and opens the demo connected to it. It finds what is on your computer: a local model server (Ollama, LM Studio), Claude Code and Codex if you are signed in to them. The first time, the browser asks whether the site may reach your computer: allow it. Later visits connect by themselves while the bridge runs (press **Disconnect** to forget it).

Gemini works too: put `GEMINI_API_KEY=…` (a key from [Google AI Studio](https://aistudio.google.com)) in a `.env.local` file in the folder you run the command from.

- **Ollama**: pull a chat model first, for example `ollama pull qwen3:14b`. A local model has to answer within the LLM's 15 s interval to keep up; if answers fail, Ollama's default context window may be too small for the rulebook and a report (about 6k tokens, an estimate): `OLLAMA_CONTEXT_LENGTH=16384 ollama serve` (not measured). Another server: `LOCAL_LLM_URL` (LM Studio: `http://localhost:1234/v1`), `LOCAL_LLM_KEY` if it needs a key.
- **Claude**: if Claude Code is installed and signed in on this computer, the bridge uses it (through Anthropic's Agent SDK, which runs Claude Code); with `ANTHROPIC_API_KEY` set, it uses the key instead. Anthropic's Agent SDK documentation says third-party developers may not offer claude.ai sign-in for their products without Anthropic's approval, so using your own Claude Code sign-in through this bridge is at your own judgement; an Anthropic API key is the documented way.
- **Codex**: if Codex is installed and signed in (`codex login`), the bridge runs your `codex` with the game's rulebook as its instructions, its commands, web search, connectors and MCP servers off and a read-only sandbox; Codex keeps the match's conversation in its own session files. `CODEX_PATH` points at another `codex`.

The first start downloads the Agent SDK with Claude Code's own program (a few hundred MB, kept in npm's cache). The command prints what it found and the link it opened; `--no-open` starts it without opening the browser, `--port 9000` on another port. From a clone of this repository, `npm install` and `npm run bridge` start the same program. More settings, all in the environment or `.env.local`: `OPENROUTER_API_KEY` (OpenRouter's models on your key), `LLM_MAX_BUDGET_USD` (5 by default: one session's estimated spend on a paid key), `CLI_TOOL_<NAME>` (a command of your own).

Each of Claude, Codex and Gemini keeps one conversation per side and match and runs under its maker's terms and your own plan's or key's limits; the bridge offers no sign-in and passes none of your other keys on. It answers only requests from this computer, and only from the demo's site and pages on this computer; it never shows your keys. The decision models Jev and SubQ Snap are not available through it: choose **LLM**, not **LLM + Jev** or **LLM + Snap**.

Status: tested against fakes only (a fake Ollama, fake SDKs, a fake `codex`, a fake Gemini API, a fake browser opener; the page against the real bridge program in headless Chrome over http on 127.0.0.1); not yet tried with a real Ollama, real Claude, Codex or Gemini sessions, or Chrome's local network prompt on the published https demo.

## Tech

TypeScript · Vite · HTML5 Canvas · GitHub Pages

## Credits

Unit sprites, terrain tilesets, flags and towers, effects, sounds, the UI theme, key icons and the pixel font: [Ninja Adventure Asset Pack](https://pixel-boy.itch.io/ninja-adventure-asset-pack) by Pixel-boy, released under CC0 (see the `LICENSE.txt` files in `src/assets/`).
