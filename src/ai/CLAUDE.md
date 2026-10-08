# src/ai

AI layers that command the heroes of one side. Each implements `AIController` (`tick`, `isWaiting`) from `src/engine/SimulationEngine.ts` and is attached per match by `UIController.startControllers()`.

| File               | Layer                   | How                                                                                                                                  |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `JevController.ts` | 2, tactical (D6, D21)   | Every 4 s, one request per side to `/api/jev` (dev proxy → TypeSafe). One Choice question per hero over a fixed option list.         |
| `LlmController.ts` | 3, strategic (D10, D22) | Every 20 s, a whole-map report to `/api/llm` (dev server → Claude Agent SDK). Reply is JSON orders, validated before use.            |
| `AiServer.ts`      | –                       | Where `/api/jev` and `/api/llm` are: this site, or the tunnel address and password given once in the demo link (`?ai=…&key=…`, D37). |
| `GameRules.ts`     | –                       | The rulebook for both layers, built from `src/engine/Rules.ts`: the LLM system prompt and Jev's `game_rules` (D26).                  |
| `Observations.ts`  | –                       | Values computed by code for both layers: group stats, local force ratio, army HP (R5).                                               |

## Conventions

- Only command heroes with `controller === 'ai'` of the controller's own faction.
- Apply decisions only through `engine.issueCommand(hero, command, 'jev' | 'llm')`.
- Jev may only return options we define; the LLM's free-form reply must be validated (hero exists, sector valid, target alive). Invalid orders are logged and skipped, never guessed.
- Keep inputs small and within scope (D16): Jev sees one hero's surroundings, the LLM the whole map.
- Code computes, the AI judges (R5): pass computed values (force ratios, group stats, recent losses), never raw unit lists or screenshots.
- Jev has no memory: every request carries `game_rules`. The LLM gets the rulebook once per match as its system prompt.
- Log every decision with its response time (`decisions`); these feed the latency experiments.
- Never start a new request while one is open; count it as skipped (Q7).
- Every request has a timeout (LLM 120 s, Jev 30 s, `timeoutMs`); a request without an answer counts as a failure, so paused AI timing can never freeze the battle.
- Controllers implement `dispose()`: the engine disposes them on restart and when they are replaced, which aborts the open request and drops a late answer, so it cannot reach the heroes of the next match. One malformed entry in the LLM's `orders` is skipped with a reason, not treated as a failure.
- On failure, stop the layer and set `failure` (shown in the AI panel and written to the match log) with the server's own error text when it gives one and a hint on what to do (e.g. a tunnel or proxy status such as Cloudflare's 530 means the AI server cannot be reached); hand heroes to the rule layer only if no other AI layer is attached (`fallbackToRules`).
- Never use `Math.random`: the simulation draws from it, so an AI layer that did would change the battle it is playing (the match id uses `crypto`).
- `window.ai.west` / `window.ai.east` (`{ jev, llm }`) expose the running controllers for inspection in the browser console.
