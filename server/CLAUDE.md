# server

Code that runs inside the Vite dev server (Node), never in the browser. Loaded from `vite.config.ts`.

| File | Role |
|---|---|
| `llmPlugin.ts` | `POST /api/llm`: one persistent, lean Claude Agent SDK session per side (D10, D22). A new `matchId` starts a new session. |

The Jev proxy (`/api/jev`) is configured directly in `vite.config.ts`: it adds `TYPESAFE_API_KEY` from `.env.local` and drops the browser's `Origin` header (D7, P1).

## Conventions

- Uses the developer's own Claude login (personal, local use; D9, D10). Final experiments switch to the Claude API.
- Keep sessions lean: custom system prompt, no tools, no project settings, auto memory off. The default Claude Code setup makes the model answer as a coding assistant (R2).
- The system prompt defines the reply format; the browser validates every reply anyway.
- Not part of `npm run build`: the static build has no `/api/*` endpoints.
