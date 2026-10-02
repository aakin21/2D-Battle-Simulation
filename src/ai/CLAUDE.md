# src/ai

AI layers that command the heroes of one side. Each implements `AIController` (`tick`, `isWaiting`) from `src/engine/SimulationEngine.ts` and is attached per match by `UIController.startControllers()`.

| File | Layer | How |
|---|---|---|
| `JevController.ts` | 2, tactical (D6, D21) | Every 4 s, one request per side to `/api/jev` (dev proxy → TypeSafe). One Choice question per hero over a fixed option list. |
| `LlmController.ts` | 3, strategic (D10, D22) | Every 20 s, a whole-map report to `/api/llm` (dev server → Claude Agent SDK). Reply is JSON orders, validated before use. |

## Conventions

- Only command heroes with `controller === 'ai'` of the controller's own faction.
- Apply decisions only through `engine.issueCommand(hero, command, 'jev' | 'llm')`.
- Jev may only return options we define; the LLM's free-form reply must be validated (hero exists, sector valid, target alive). Invalid orders are logged and skipped, never guessed.
- Keep inputs small and within scope (D16): Jev sees one hero's surroundings, the LLM the whole map.
- Log every decision with its response time (`decisions`); these feed the latency experiments.
- Never start a new request while one is open; count it as skipped (Q7).
- On failure, stop the layer; hand heroes to the rule layer only if no other AI layer is attached (`fallbackToRules`).
- `window.jev` / `window.llm` expose the running controllers for inspection in the browser console.
