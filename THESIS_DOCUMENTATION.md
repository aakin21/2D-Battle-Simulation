# Thesis Documentation

A running record of the project's process: what was built, which decisions were made and why, what was researched, and what is still open. Each decision gets an ID so it can be referenced in the thesis text.

**Repository:** [2D-Battle-Simulation](https://github.com/aakin21/2D-Battle-Simulation)
**Live demo:** https://aakin21.github.io/2D-Battle-Simulation/

---

## Timeline

| Date | Milestone |
|---|---|
| 2026-02-19 | Repository created |
| 2026-02-27 → 2026-04-29 | Phase 1: baseline simulation built (weeks 1–12) |
| 2026-04-29 | **Checkpoint 1**: baseline simulation complete (`5a96495`) |
| 2026-09-15 | TypeSafe AI releases Jev (System One decision model) |
| 2026-09-30 | Meeting with professor: AI integration proposed (three-layer design, symmetry, Agent vs Agent) |
| 2026-10-01 | Phase 2 begins: feasibility research for AI integration |
| 2026-10-01 | First decisions: Jev for layer 2, Vercel hosting with proxy, Agent SDK for the LLM during development (D6–D11) |

---

## Phase 1: Baseline simulation (Checkpoint 1)

**Status:** Complete. Commit `5a96495` marks the end of Phase 1.

### Goal
A browser-based simulation of large-scale battlefield behavior in which crowd behavior emerges from simple per-unit rules: morale (courage), terrain, and proximity to allies, enemies, and the hero.

### Architecture
TypeScript + Vite + HTML5 Canvas, fully client-side, deployed to GitHub Pages via GitHub Actions.

| Component | File | Responsibility |
|---|---|---|
| Simulation Engine | `src/engine/SimulationEngine.ts` | Behavior rules, courage, combat, movement, wave spawning |
| Pathfinder | `src/engine/Pathfinder.ts` | A* with Manhattan heuristic and binary min-heap |
| Spatial Grid | `src/engine/SpatialGrid.ts` | Spatial partitioning for neighbor queries |
| Berserker Pool | `src/engine/BerserkerPool.ts` | Object pooling for spawned units |
| State Manager | `src/state/StateManager.ts` | Battlefield data, unit map, hero cache |
| Renderer / Minimap | `src/rendering/` | Canvas rendering, off-screen culling, minimap |
| UI Controller / Input | `src/ui/` | Menu, config screen, controls, input handling |

### Implemented features (by week)
| Week | Feature |
|---|---|
| 1 | Core engine skeleton: 150×150 grid, procedural terrain (open, forest, swamp, mountain), camera, unit spawning |
| 2 | A* pathfinding, terrain speed modifiers (1.0 / 0.7 / 0.5 / impassable) |
| 3 | Combat: 2-tile range, 1 s attack interval, simultaneous damage, HP bars |
| 4 | Courage system (wounds, ally/enemy ratio in sight, hero proximity); ESLint + Prettier |
| 5 | Flee (courage < 25, 1.5× speed) and rest (HP < 50, regen 10 HP/s) behavior |
| 6 | Hero task point (right-click), charisma radius and courage bonus |
| 7 | Berserker wave spawning and group patrol behavior |
| 8 | UI: controls, minimap, config screen, camera improvements |
| 9 | Performance: spatial grid partitioning, berserker object pool |
| 10 | Performance: O(1) unit lookup (unit map) and hero reference cache |
| 11 | Performance: A* open list replaced with binary min-heap |
| 12 | Deployment workflow, README, terrain-based sight multipliers, 2000 vs 2000 stress test mode |

### Behavior model
Each unit cycles through `IDLE → ATTACK → FLEE → REST → IDLE`, driven by:
- **Courage** = base + wound penalty (−10 per 20% HP lost) + ratio modifier (+15 if allies > 60%, −15 if < 40%, −30 if < 20%) + hero charisma bonus (if within radius), clamped to 0–100.
- **Sight** is reduced by terrain (forest 0.8, swamp 0.7).

### Known limitations at Checkpoint 1
These became relevant once AI integration was proposed:
- **Asymmetric sides.** Warriors follow a single hero and use courage; berserkers have no courage (skipped in `updateCourage`), no hero, and simply spawn in waves and attack the nearest opponent.
- **Small control surface.** The only steerable input is the hero's task point.
- **Non-deterministic runs.** Map generation and spawning use `Math.random` without a seed, so runs cannot be reproduced exactly.
- **No headless mode or metric export.** Results can only be observed visually.

---

## Phase 2: AI integration

### Motivation
Phase 1 shows that emergent crowd behavior can come from simple per-unit rules. The open question is what happens when **AI decision-makers** steer that crowd at higher levels: can AI models make useful tactical and strategic decisions inside a real-time simulation, and how does decision latency affect the outcome?

A key enabler is the release of **Jev** (2026-09-15). Real-time tactical control needs a model that makes decisions in well under a second; conventional LLMs take several seconds per call, which is too slow for a loop that runs every few seconds. Jev returns typed decisions in 70–500 ms, which makes a fast AI layer realistic for the first time. A slower but more capable LLM can then sit above it for strategic decisions.

This mirrors Kahneman's *System 1 / System 2* distinction: a fast, intuitive decision-maker (Jev) and a slow, deliberate one (LLM). This framing can serve as the conceptual backbone of the thesis.

### Proposed design (from the professor meeting, 2026-09-30)

| Layer | Frequency | Scope | Decision-maker |
|---|---|---|---|
| 1. Algorithmic | Every frame | Individual unit: movement, attack, flee, rest | Existing rule-based system (Phase 1) |
| 2. Tactical | Every 3–5 s | Local surroundings of each hero | **Jev** |
| 3. Strategic | Every 15–30 s | Entire map | **LLM** (Claude / ChatGPT) |

Additional requirements:
- **Symmetric sides:** berserkers work like warriors (own hero, courage, charisma).
- **Agent vs Agent mode:** a separate AI agent controls each side.
- **Two latency modes**, selectable at setup:
  - *Paused (synchronous):* the simulation waits for AI decisions. Fair and reproducible.
  - *Real-time (asynchronous):* the simulation keeps running and decisions apply when they arrive. Latency becomes part of the challenge.

---

## Decision log

Status values: **Proposed** (suggested, not yet decided), **Accepted** (explicitly confirmed by the author), **Rejected**, **Superseded by D#**.

D1–D4 are the professor's proposals from the 2026-09-30 meeting; D5 onwards came up during the follow-up discussion and research.

| ID | Date | Decision | Rationale | Status |
|---|---|---|---|---|
| D1 | 2026-09-30 | Use a three-layer decision system (rules / tactical / strategic) | Each layer works at the speed that fits its decision-maker. See record below | Accepted (2026-10-01) |
| D2 | 2026-09-30 | Make the two sides symmetric | Required for User vs Agent and Agent vs Agent. See record below | Accepted (2026-10-01) |
| D3 | 2026-09-30 | Game modes: Manual, User vs Agent, Agent vs Agent (built in this order) | Each mode builds on the previous one. See record below | Accepted (2026-10-01) |
| D4 | 2026-09-30 | Two AI response modes: Paused and Real-time, chosen at setup; record every AI response time | Compares ideal vs realistic AI timing. See record below | Accepted (2026-10-01) |
| D5 | 2026-10-01 | Maps: one fixed map, a random map, and a "save map" option | Lets any map be replayed for experiments. See record below | Accepted (2026-10-01) |
| D6 | 2026-10-01 | Use Jev for layer 2 (tactical decisions) | Fast enough for a 3–5 s loop; outputs map directly to commands. See record below | Accepted (2026-10-01) |
| D7 | 2026-10-01 | Call AI services through a small proxy, not directly from the browser | Jev blocks browser calls; keeps the API key hidden. See record below | Accepted (2026-10-01) |
| D8 | 2026-10-01 | Host the site and the proxy on Vercel | One platform, free, no server to maintain. See record below | Accepted (2026-10-01) |
| D9 | 2026-10-01 | The AI demo is online (public link), but only the author uses it | Must run online; no other users to plan for. See record below | Accepted (2026-10-01) |
| D10 | 2026-10-01 | LLM layer: Claude Agent SDK during development, Claude API for final experiments | Fastest option without extra cost now; API gives real latency later. See record below | Accepted (2026-10-01) |
| D11 | 2026-10-01 | LLM memory: in-match memory + learning across matches | Lets the LLM improve over time; a measurable thesis result. See record below | Accepted in principle: research first, build if feasible |
| D12 | 2026-10-01 | Add objectives: a base for each side + 2–3 control points | Without objectives the only strategy is "group up and attack". See record below | Proposed (idea kept for later) |
| D13 | 2026-10-01 | AI commands heroes only; each side has 2–3 heroes | Keeps the Phase 1 charisma mechanic; heroes allow the army to split. See record below | Accepted (2026-10-01) |
| D14 | 2026-10-01 | Command set: move, hold, retreat, attack, flank left/right, attack a target, continue LLM order. Commands never change courage | Rich enough for real tactics; courage stays an independent system. See record below | Accepted (2026-10-01) |
| D15 | 2026-10-01 | LLM and Jev both command heroes (latest command wins); each knows the other's latest decision | Two independent algorithms that do not blindly override each other. See record below | Accepted (2026-10-01) |
| D16 | 2026-10-01 | Input scope: LLM reads the whole map, Jev reads only each hero's surroundings | Small input keeps Jev fast. See record below | Accepted (2026-10-01) |
| D17 | 2026-10-01 | Locations are given as a sector grid (e.g. 10×10, A1–J10) | Works without fixed landmarks; fits Jev's option limit. See record below | Accepted (2026-10-01) |
| D18 | 2026-10-02 | Heroes move at their group's speed, and have a survival reflex (rule layer) | Stops heroes from running ahead alone and dying, which the AI layers are too slow to prevent. See record below | Accepted (2026-10-02) |

### Decision records

Each record lists the options we considered, what we chose, and why.

#### D1: Three-layer decision system
- **Options:** (a) keep one rule-based loop, (b) one AI controls everything, (c) three layers working at different speeds.
- **Chosen:** Three layers: rules every frame (each unit), Jev every 3–5 s (around each hero), LLM every 15–30 s (whole map).
- **Why:**
  - Each decision-maker is used at the speed it can handle. Rules are instant, Jev is fast, the LLM is slow but sees the big picture.
  - It matches the "fast and slow thinking" idea (Kahneman's System 1 / System 2), which gives the thesis a clear framework.
  - The existing rule-based system (Phase 1) stays as the base layer, so no work is lost.
- **Note:** This is the largest and most complex part of Phase 2.

#### D2: Symmetric sides
- **Options:** (a) keep the current setup (warriors with a hero vs berserker waves), (b) give both sides the same structure.
- **Chosen:** Same structure for both sides: each has a hero, courage and charisma, and accepts the same commands.
- **Why:**
  - User vs Agent needs an opponent that can be commanded like the user's side.
  - Agent vs Agent is only fair if both sides have the same abilities.
  - It is the first thing to build, before any AI work.

#### D3: Game modes
- **Options:** (a) only AI modes, (b) Manual + Agent vs Agent, (c) Manual, User vs Agent, Agent vs Agent.
- **Chosen:** (c), built in this order.
- **Why:**
  - **Manual** (user controls the hero, no AI) is the current Phase 1 game. It always works, even without AI or internet.
  - **User vs Agent** comes next: the user controls one side, the AI the other.
  - **Agent vs Agent** comes last: the same agent is simply placed on the user's side as well. It reuses everything from User vs Agent.
  - A user's click and an AI decision go through the same command interface, so modes only differ in who gives the orders.

#### D4: AI response modes (Paused and Real-time)
- **Options:**
  - (a) Paused only
  - (b) Real-time only
  - (c) both, chosen at setup
  - (d) a simulated, fixed delay (considered, dropped as unnecessary complexity)
- **Chosen:** (c).
- **How it works:**
  - **Paused:** when an AI decision is requested, the game stops until the answer arrives, then continues. In Agent vs Agent it waits for both sides; in User vs Agent it waits for the agent. When Jev and the LLM are asked at the same moment, it waits for both.
  - **Real-time:** the game never stops. Each answer is applied when it arrives. Jev and the LLM work independently.
- **Why:**
  - Paused mode shows the AI's "ideal" performance: its speed does not matter.
  - Real-time mode is realistic: slow answers arrive late, when the battle may have changed.
  - Comparing the two shows how much AI response time affects the outcome.
  - We do not set the delay ourselves. We record how long every AI answer takes, so the thesis can report real response times for Jev and the LLM.
  - The game speed setting stays. Note: in Real-time mode, a higher game speed means more game time passes before an answer arrives.

#### D5: Maps
- **Options:** (a) a fixed map only, (b) random maps only, (c) fixed map + random map + save option.
- **Chosen:** (c).
- **Why:**
  - A fixed map makes matches comparable.
  - Random maps test whether a strategy works in general and not just on one map.
  - "Save map" lets any map (including a random one) be loaded again, so the same map can be used for many matches in an experiment.

#### D6: Jev for layer 2 (tactical decisions)
- **Options:** (a) keep layer 2 rule-based, (b) a conventional LLM, (c) Jev.
- **Chosen:** Jev.
- **Why:**
  - Layer 2 decides every 3–5 s. LLMs take several seconds per call, which is too slow. Jev answers in 70–500 ms (vendor claim) plus ~0.2 s network (R1).
  - Jev can only return options we define. It cannot produce an invalid command, so no parsing errors.
  - Every answer has a confidence value. Low-confidence decisions can be ignored.
  - Very cheap: about $0.02 per match (R3).
  - It was released for exactly this kind of real-time loop (games, simulations). Its release is what made this design possible.

#### D7: Proxy for AI calls
- **Options:** (a) call the AI services directly from the browser, (b) go through a small proxy.
- **Chosen:** Proxy.
- **Why:**
  - Jev's API rejects requests from browsers (CORS). Only server-side calls work (P1).
  - Calling from the browser would put the API key in the page, visible to anyone who opens the demo.
  - A proxy adds almost no delay. Most of the time is the distance to TypeSafe's servers (R1).

#### D8: Vercel for hosting
- **Options:**
  - (a) a full backend server (e.g. Express)
  - (b) a rented server (VPS)
  - (c) run the proxy on the author's own computer
  - (d) keep GitHub Pages and add a separate proxy service (e.g. Cloudflare Worker)
  - (e) local Vite dev proxy only
  - (f) move to Vercel: site and proxy function together
- **Chosen:** Vercel.
- **Why:**
  - GitHub Pages only serves files. It cannot run the proxy code.
  - A full backend or a rented server is too much for a 20–30 line proxy: we would have to maintain an always-on server (updates, HTTPS, crashes).
  - The author's computer is not always on, so the online demo would stop working.
  - GitHub Pages plus a separate proxy means two platforms to manage, and we would have to configure CORS ourselves.
  - A local Vite proxy does not work for the online demo (D9).
  - Vercel keeps the site and the proxy in one project with one deploy. The API key stays in Vercel's settings. Site and proxy share the same address, so there is no CORS problem.
  - The free plan is more than enough (R3).
- **Risk:** The first request after a quiet period can take ~100–300 ms longer (cold start). To be measured (Q14).

#### D9: Online demo, used only by the author
- **Options:** (a) run only locally, (b) online demo open to everyone, (c) online demo used only by the author.
- **Chosen:** (c).
- **Why:**
  - The project must be reachable online, not only on one computer.
  - Nobody else will use it, so we do not need visitor limits or cost protection.
  - This also allows the LLM layer to use the author's personal subscription during development (D10).

#### D10: How to call the LLM (layer 3)
- **Options:** (a) Claude API, (b) `claude -p` (Claude Code command line), (c) Claude Agent SDK with a persistent session.
- **Chosen:** Agent SDK during development, Claude API for final experiments.
- **Why:**
  - `claude -p` takes ~6–7 s per call because it starts Claude Code from zero every time (R2).
  - The Agent SDK can keep one session open. With a lean setup, a decision takes ~1.3–2.3 s (R2). That easily fits the 15–30 s interval.
  - The Agent SDK runs on the author's subscription, so development costs nothing extra. The API costs about $0.12–0.24 per match (R2).
  - The lean setup is also needed for correct answers: with the default setup, the model behaved like a coding assistant (R2).
  - The final latency experiments need the API, because the Agent SDK adds its own delay and would distort the results.
  - All LLM calls go through one function, so switching to the API is a small change.
- **Architecture by phase:**

| Phase | Layer 2 (Jev) | Layer 3 (LLM) |
|---|---|---|
| Development | Vercel function | Local, Agent SDK (subscription) |
| Final experiments | Vercel function | Vercel function, Claude API |

#### D11: LLM memory and learning
- **Options:** (a) no memory, (b) memory within a match only, (c) memory within a match + learning across matches.
- **Chosen:** (c), if feasible. Research comes first (Q15).
- **Why:**
  - Memory within a match lets the LLM follow a consistent strategy instead of deciding from scratch each time.
  - Learning across matches: after each match, the LLM writes short "lessons learned". These are added to its prompt in later matches. The model itself does not change. This follows the Reflexion approach (Shinn et al., 2023).
  - It gives a clear, measurable thesis result: does the win rate improve over many matches?
  - It will be built as a switch on top of a no-memory baseline, so (a), (b) and (c) can be compared.
- **Risks to research:**
  - With learning on, matches are no longer independent, so other experiments must run with learning off.
  - On a fixed map, the LLM may learn map-specific tricks instead of general strategy.
  - The lesson list can grow too large or contradict itself.
  - If only one side learns, Agent vs Agent is not fair.

#### D12: Objectives (base + control points), idea for later
- **Options:**
  - (a) keep elimination as the only goal
  - (b) base destruction
  - (c) capture the flag
  - (d) control points
  - (e) base + control points
- **Proposed:** (e).
- **Why:**
  - With elimination as the only goal, the best strategy is always "group up and attack". The LLM has no real strategic choices to make.
  - Objectives create trade-offs: attack or defend, split the army or not, which point to take first.
  - **Base:** each side has a base. Reinforcements come from it, and losing it means losing the match. This replaces the current wave system with symmetric reinforcements (Q10).
  - **Control points:** 2–3 points on the map. Holding them gives an advantage (e.g. faster reinforcements or a courage bonus). This forces the sides to split forces and makes terrain matter.
  - Capture the flag was not chosen: one unit carrying a flag does not fit a crowd simulation well.
  - It fits the layers: the LLM decides which points to take and how many units defend the base; Jev decides whether to hold, push or retreat at a point.
  - Gives a clear win condition (destroy the enemy base, or hold more points when time runs out), which also defines the metrics (Q11).
- **Scope:** adds work. Start with the base only, add control points after.

#### D13: Who receives AI commands
- **Options:** (a) only one hero per side, (b) 2–3 heroes per side, (c) heroes + direct commands to unit groups.
- **Chosen:** (b). The AI commands heroes only. Units follow heroes through charisma, as in Phase 1.
- **Why:**
  - Keeps the existing charisma mechanic: heroes lead, units follow.
  - Several heroes let a side split its army (e.g. one group attacks, another defends).
  - Direct commands to units would bypass the crowd behavior the project is built on, and add much complexity.

#### D14: Command set
- **Options:** (a) basic: move, hold, retreat; (b) basic + stance (aggressive / defensive); (c) wide set.
- **Chosen:** Wide set, without stance:
  - move to a sector
  - hold position
  - retreat
  - attack
  - flank left / flank right
  - attack a specific target
  - continue the LLM's order (Jev only, see D15)
- **Why:**
  - A wide set gives the AI real tactical choices.
  - **Courage is a separate, independent algorithm. No command can change it.** If Jev orders an attack, the hero attacks and units follow. A unit whose courage is low and is fleeing cannot be forced to attack. The unit's own behavior (flee, rest) always comes first, as in Phase 1.
  - Stance was dropped because it would change courage thresholds from outside.
- **To define later:** what "flank left/right" is relative to (likely the nearest enemy group), and which targets "attack a target" can choose from (Jev can only pick from a predefined list, e.g. enemy hero 1/2/3 or the nearest enemy group).

#### D15: How the LLM and Jev work together
- **Options:**
  - (a) the LLM gives goals and Jev only acts inside them
  - (b) both command heroes independently, latest command wins, without knowing about each other
  - (c) both command heroes, latest command wins, and each knows the other's latest decision
- **Chosen:** (c).
- **Why:**
  - The LLM and Jev are separate algorithms. Both can command a hero directly. When the LLM sends a command it applies; when Jev sends one later, Jev's applies.
  - Without knowing the LLM's order, Jev would override it a few seconds later for no reason. So Jev's input includes the LLM's latest order (e.g. "LLM order: move to D4").
  - Jev gets an extra option, **"continue the LLM's order"**. Normally Jev picks it and the hero keeps following the LLM's plan. In danger (e.g. the hero is being surrounded) Jev can choose "retreat" instead. When the danger is over, Jev can return to the LLM's order, so the plan is paused, not lost.
  - The LLM also receives Jev's recent decisions, so it can draw conclusions (e.g. "hero 2 keeps retreating, that area is too strong").

#### D16: What each AI layer sees
- **Options:** (a) both see the whole map, (b) both see only local surroundings, (c) LLM sees the whole map, Jev sees only each hero's surroundings.
- **Chosen:** (c).
- **Why:**
  - The LLM makes strategic decisions, so it needs the full picture. It is asked only every 15–30 s.
  - Jev makes local, tactical decisions every 3–5 s. A small input (only what is around the hero) keeps it fast and focused.
  - The questions for all heroes on one side can go in a single Jev request; Jev answers them in parallel.

#### D17: How locations are described
- **Options:** (a) a sector grid (e.g. A1–J10), (b) named places (base, control point 1, north forest), (c) exact x,y coordinates.
- **Chosen:** Sector grid.
- **Why:**
  - Bases and control points are not decided yet (D12), so named places cannot be relied on.
  - Short and easy for the LLM to read and write.
  - Jev can only choose from a list, and a 10×10 grid (100 options) fits its 255-option limit. Jev cannot produce coordinates.

#### D18: Keeping heroes alive (rule layer)
- **Problem:** Heroes arrive before their units and die alone. Two causes in the Phase 1 code:
  - Heroes are 50% faster than warriors (speed 3.0 vs 2.0).
  - Warriors only follow a hero's task point while the hero is within 15 tiles (`SimulationEngine.ts`, `getDestination`). Once the hero pulls ahead past 15 tiles, the warriors stop following.
  - Heroes have no courage, so they never retreat and fight until they die.
- **Why the AI cannot fix it:** Jev decides every 3–5 s and the LLM every 15–30 s. Neither can give second-by-second control. Instant reactions belong in the rule layer (layer 1).
- **Options:**
  - (a) hero waits until enough of its group is nearby
  - (b) hero moves at its group's speed
  - (c) hero leads from behind (units go first)
  - (d) hero survival reflex
- **Chosen:** (b) + (d).
- **Why:**
  - (a) needs arbitrary thresholds ("how many units?", "which units count?") and the hero can wait forever if its units are fighting or fleeing.
  - (b) removes the cause with no thresholds: hero and units travel together, so the hero stays within the 15-tile follow range. Small gaps from terrain are not enough to break it.
  - (d) is a safety net for when the group breaks apart in combat: if the hero's HP is low or enemies heavily outnumber allies around it, the hero falls back to its own units, whatever the AI ordered. The AI sees this at its next decision.
  - Like fleeing units that cannot be forced to attack (D14), the rule layer's reflexes always come first.
  - This is a concrete example of why the three-layer design is needed: the AI plans, the rules react.

---

## Research log

### R1: Jev feasibility for layer 2 (2026-10-01)

**Question:** Can Jev make tactical decisions fast enough and in a usable format for a 3–5 s decision loop?

**What Jev is.** Jev is a "System One" model from TypeSafe AI, released 2026-09-15. It is non-autoregressive: it does not generate text. It reads a `state` once and answers a set of typed questions in parallel, in a single pass.

**Interface.** `POST https://api.typesafe.ai/v1/systemone` with `model: "jev-latest"`, a `state` (string, JSON object, or array) and a map of `questions`. There are three question types:

| Type | Returns | Example use in the simulation |
|---|---|---|
| Choice | One option from a predefined set (max 255) + probability per option + confidence | Tactical action: attack / hold / retreat / flank |
| Score | A value on an ordered scale (2–10 levels) + probabilities + confidence | Threat level of the hero's surroundings |
| Noul | Probability (0–1) that a yes/no statement is true | "Is the hero being surrounded?" |

**Key properties (Jev 1.13):**
- Latency 70–500 ms end-to-end (vendor claim)
- $0.042 per million input tokens; output tokens are free
- Context limit 64k tokens per request (32k for state + longest question)
- Rate limits 100K tokens/s and 40 requests/s (adjusting dynamically)
- Outputs can only be values from the predefined schema, so no parsing errors
- Text input only; English works best

**Findings:**
- Latency fits the 3–5 s interval with a large margin. ✅
- The Choice primitive maps directly onto a fixed command set, so Jev can never return an invalid command. ✅
- Confidence values allow gating: a low-confidence decision can be ignored, and the unit keeps its current behavior. This is a possible thesis discussion point. ✅
- ⚠️ **Browser access is blocked.** A CORS preflight from `https://aakin21.github.io` returned `Disallowed CORS origin`. The official JS SDK targets Node.js 20+. The project cannot stay fully client-side if it calls Jev, so a small proxy is needed (D7).
- ⚠️ Performance figures are vendor claims; latency should be measured independently inside the simulation.

**Network latency measurement (2026-10-01).** Measured with `curl` from the development machine (Europe) using unauthenticated requests. These return `401` immediately, so the numbers are pure network time without model inference:

| Step | Time |
|---|---|
| TCP connect to Cloudflare edge (Budapest) | ~10 ms |
| TLS handshake | ~15–40 ms |
| Edge → TypeSafe origin → back (first byte) | ~180–200 ms |
| **Total, new connection** | **~210–250 ms** |
| Total, reused connection (keep-alive) | ~190–205 ms |

- The edge is close; most network time is the distance to TypeSafe's origin servers (location not published; the timing suggests outside Europe).
- Expected end-to-end decision time ≈ network (~0.2 s) + inference (0.07–0.5 s, vendor claim) ≈ 0.3–0.7 s. Must be confirmed with an API key.
- A proxy (needed for P1) mostly *relocates* the network distance rather than adding to it: placed near TypeSafe's origin, it adds only its own small processing time. Reusing connections saves the TLS handshake (~20–40 ms).
- Latency does not limit how *often* decisions can be requested: requests can overlap (rate limit 40 requests/s). Latency determines how *stale* a decision is when it arrives. See Q12.

**Conclusion:** Jev is a technically feasible choice for layer 2, provided API calls go through a proxy.

**Sources:**
- [Introducing System One Models & Jev (TypeSafe AI blog)](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [TypeSafe documentation: API, Models, JavaScript SDK](https://docs.typesafe.ai/llms.txt)
- [Jev (AI model), Wikipedia](https://en.wikipedia.org/wiki/Jev_(AI_model))

### R2: How to call the LLM for layer 3 (2026-10-01)

**Question:** Which way of calling Claude is fast and cheap enough for strategic decisions every 15–30 s?

**Options compared:**
- **Claude API (Client SDK):** direct HTTP call, fastest, billed per token.
- **`claude -p` (Claude Code CLI, headless):** uses the author's Claude subscription; starts a full Claude Code process per call.
- **Claude Agent SDK:** "Claude Code as a library"; runs the Claude Code binary as a subprocess, can keep one session open and accept new messages over time. Configurable: custom system prompt, no tools, no settings/memory loading, model choice, structured output.

**API pricing (per million tokens, input / output):** Haiku 4.5 $1 / $5 · Sonnet 5.5 $2 / $10 · Opus 5.5 $4 / $20. Rough estimate for a 5-minute match with a decision every 20 s (15 calls, ~3k input + ~1k output tokens each): ~$0.12 (Haiku) to ~$0.24 (Sonnet) per match, before optimizations (caching, smaller state, longer interval).

**Measurement 1: `claude -p`.** Trivial prompt ("Reply with only: ok"), two runs: 6.85 s and 5.83 s. Most of this is process startup and Claude Code's large system prompt; an already-open interactive Claude Code session does not help, since each call starts a new process.

**Measurement 2: Agent SDK** (`@anthropic-ai/claude-agent-sdk` 0.3.286). Task: a small battlefield summary as JSON, answer `attack` / `hold` / `retreat`. 4 decisions per configuration. "Lean" = custom system prompt, `tools: []`, `settingSources: []`, `persistSession: false`, auto memory disabled.

| Configuration | Haiku | Sonnet |
|---|---|---|
| New call per decision, default setup | ~7.9 s | ~7.9 s |
| New call per decision, lean | ~11.6 s (one 20 s outlier) | ~3.9 s |
| **Persistent session, lean** | **first 7.8 s, then ~2.3 s** | **first 1.7 s, then ~1.3 s** |

**Findings:**
- ✅ A persistent lean session cuts decision time from ~8 s to ~1.3–2.3 s, well inside a 15–30 s interval. The first-call delay can be hidden by starting the session before the match (`startup()`).
- ✅ The lean configuration is also needed for correct behavior: with the default Claude Code setup the model answered as a coding assistant ("I can see you've provided battle simulation data...") instead of giving the one-word decision.
- ⚠️ A persistent session keeps the conversation history: this enables in-match memory (consistent strategy) but the history grows over a match and may slow responses. See D11.
- ⚠️ Small, noisy sample (4 runs, network-dependent). Repeat with a longer test.
- ⚠️ Anthropic does not allow claude.ai subscription login in products offered to others (Agent SDK documentation). Here the use is personal (D9), and final experiments use the API (D10).
- API latency not measured yet (no key); expected to be lower since there is no Claude Code layer in between.

**Conclusion:** Agent SDK with a persistent, lean session for development; Claude API for final experiments (D10).

**Sources:**
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)

### R3: Hosting cost for the proxy (2026-10-01)

**Question:** Does running the Jev proxy on Vercel cost money?

- Vercel Hobby (free) plan: 1M function invocations, 4 h active CPU, 100 GB data transfer per month; for personal, non-commercial use (a thesis project qualifies).
- Estimated usage: a 5-minute match with a Jev call every 3 s for both sides ≈ 200 calls. 100 matches/month ≈ 20,000 calls (~2% of the limit). The proxy only forwards requests, so CPU per call is a few ms; waiting for Jev does not count as active CPU.
- Jev cost: ~1–2k input tokens per call ≈ 400k tokens per match ≈ under $0.02 per match (estimate; verify with real token counts).

**Conclusion:** The proxy is free on the Hobby plan; Jev costs a few dollars per month at most.

**Sources:** [Vercel pricing](https://vercel.com/pricing), [Jev models and pricing](https://docs.typesafe.ai/models.md)

---

## Problems log

Problems encountered during the project, how they were found, and how they were resolved. Status values: **Open**, **Workaround**, **Resolved**.

### P1: Jev API cannot be called from the browser (2026-10-01)
- **Context:** Feasibility research for layer 2 (R1).
- **Problem:** The project is fully client-side and hosted on GitHub Pages, so it has no backend. Browsers only let a web page call another domain's API if that API allows the page's origin (CORS). CORS preflight tests against `https://api.typesafe.ai/v1/systemone`:
  - `https://aakin21.github.io` → `400 Disallowed CORS origin`
  - `http://localhost:5173` (Vite dev server) → `400 Disallowed CORS origin`
  - `https://console.typesafe.ai` → `200`, allowed

  The API only accepts browser requests from TypeSafe's own console. Server-side calls (curl, Node.js) are not subject to CORS. The official JavaScript SDK targets Node.js 20+, not browsers.
- **Root cause:** Missing backend, not a Jev limitation. Even if CORS were allowed, calling the API from the browser would expose the API key to every visitor of the public demo.
- **Impact:** Jev cannot be called directly from the simulation running in the browser.
- **Resolution:** Route AI calls through a small proxy (D7), hosted as a Vercel serverless function (D8). This also keeps API keys off the client.
- **Status:** Open (solution decided, not yet implemented)

---

## Open questions

| # | Question | Notes / current thinking |
|---|---|---|
| Q1 | What command set will layers 2 and 3 control? | Answered by D13, D14 |
| Q2 | How do layers 2 and 3 interact when they disagree? | Answered by D15 |
| Q3 | What surrounding information is passed to Jev? | Scope set by D16 (hero surroundings + latest LLM order). Exact fields still to define |
| Q4 | How is the full map summarized for the LLM? | Locations as sector grid (D17). Exact format still to define |
| Q5 | Proxy hosting for the live demo | Answered by D8 (Vercel) |
| Q6 | Real-time mode: how does the speed multiplier interact with latency? | Answered by D4: speed setting stays; at higher speed more game time passes before an answer arrives. Response times are recorded |
| Q7 | Real-time mode: a new decision is due but the previous one hasn't arrived | Suggestion: skip it and count skipped calls as a metric |
| Q8 | Does the latency mode apply to both AI layers? | Answered by D4: yes, both Jev and the LLM |
| Q9 | Agent vs Agent: same model on both sides, or different models? | Suggestion: both. A mirror match is the control experiment. |
| Q10 | Does wave spawning stay in the symmetric setup? | If D12 is adopted: waves become symmetric reinforcements from each side's base |
| Q11 | Which metrics will the thesis report? | Win rate, casualties, survival time, decision latency, skipped decisions, cost. Requires headless mode and export. |
| Q12 | How should the layer 2 decision frequency relate to Jev latency (~0.3–0.7 s)? | Latency limits decision freshness, not frequency. Options: overlapping requests, batching all heroes into one request (Jev evaluates questions in parallel), smaller state. Needs real measurements (R1). |
| Q13 | What are Jev's real end-to-end latency and token cost per call? | Needs an API key; measure inside the simulation (R1, R3) |
| Q14 | How large is the Vercel cold start in practice? | Measure after deployment (D8) |
| Q15 | Is cross-match learning (D11) feasible, and how should it be built? | Research: lesson format and size limit, summarizing old lessons, effect of a fixed vs varied map (risk of map-specific lessons), fairness in Agent vs Agent, keeping other experiments independent (learning off). Related work: Reflexion (Shinn et al., 2023) |
| Q16 | Does the persistent LLM session slow down as history grows over a match? | Repeat R2 measurement over a full-length match; reset the session periodically if needed |
