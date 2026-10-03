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
| D14 | 2026-10-01 | Command set: move, hold, retreat, attack, flank left/right, attack a target, continue LLM order. Commands never change courage | Rich enough for real tactics; courage stays an independent system. See record below | Superseded by D20 (2026-10-02) |
| D15 | 2026-10-01 | LLM and Jev both command heroes (latest command wins); each knows the other's latest decision | Two independent algorithms that do not blindly override each other. See record below | Accepted (2026-10-01) |
| D16 | 2026-10-01 | Input scope: LLM reads the whole map, Jev reads only each hero's surroundings | Small input keeps Jev fast. See record below | Accepted (2026-10-01) |
| D17 | 2026-10-01 | Locations are given as a sector grid (e.g. 10×10, A1–J10) | Works without fixed landmarks; fits Jev's option limit. See record below | Accepted (2026-10-01) |
| D18 | 2026-10-02 | Heroes move at their group's speed, and have a survival reflex (rule layer) | Stops heroes from running ahead alone and dying, which the AI layers are too slow to prevent. See record below | Accepted (2026-10-02) |
| D19 | 2026-10-02 | Keep the Phase 1 game as "Classic"; add a symmetric "Battle" mode with equal stats on both sides | Nothing that works is lost; equal stats keep AI comparisons fair. See record below | Accepted (2026-10-02) |
| D20 | 2026-10-02 | Revised command set: move to a sector, hold, retreat, attack, attack an enemy hero, continue the LLM's order; all commands go through one command interface | Flanking has no effect in this simulation (no facing or direction). One entry point for user, Jev and LLM. See record below | Accepted (2026-10-02) |
| D21 | 2026-10-02 | Jev layer, first version: what Jev sees, which options it gets, how often it is asked, and what happens on low confidence or errors | See record below | Superseded by D26 (2026-10-03) |
| D22 | 2026-10-02 | LLM layer, first version: report format, reply format, interval, model, and the opponent options (Rules / Jev / LLM / Jev + LLM) | See record below | Superseded by D26 (2026-10-03) |
| D23 | 2026-10-02 | Win condition (Battle mode): the side whose units (heroes and soldiers) all die first loses | Simple and unambiguous; every test match ended. See record below | Accepted (2026-10-02) |
| D24 | 2026-10-02 | Code organization: split the engine into sibling modules, a CLAUDE.md per folder with a root CLAUDE.md for architecture and rules, Prettier and lint clean-up; tests stay outside the repository | Keeps the code readable and the design rules explicit as the AI layers grow. See record below | Accepted (2026-10-02) |
| D25 | 2026-10-02 | Unit sprites come from the Ninja Adventure asset pack (CC0) | Free for a public repo, top-down 16×16 with walk and attack animations. See record below and R4 | Accepted (2026-10-02) |
| D26 | 2026-10-03 | AI inputs v2: complete rulebook for both layers built from the engine's constants, computed summaries instead of raw data, stance and plan memory for the LLM, sub-sector targets, Jev assessments reported to the LLM | Applies R5; fixes the missing rules and repeated decisions seen in the first LLM vs LLM match. See record below | Accepted (2026-10-03) |
| D27 | 2026-10-03 | Fighting and breaking off: heroes fight what they meet on a move; a different order during a fight breaks off until clear of enemies; repeated orders change nothing | Orders like retreat were ignored while a hero was fighting. See record below | Accepted (2026-10-03) |

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
- **Implementation (2026-10-02):** the Battle menu chooses who commands each side: West = You / Jev / LLM / Jev + LLM, East = Rules / Jev / LLM / Jev + LLM. Any pairing is possible, e.g. LLM vs Jev + LLM. Each side gets its own AI controllers and its own LLM session; the user can only command heroes they control.
- **First Agent vs Agent match (LLM vs LLM, Sonnet, fixed map, real time):** both sides made 12 decisions with no invalid orders (average response 2.2 s west, 2.8 s east). Both first formed a defensive line and waited, then both advanced at t = 60 s; east massed a counter-attack, broke the west army by t = 140 s, pulled its wounded heroes back under its soldiers and then hunted the lone west heroes. **East won at 233 s with 135 units left.** The plans are readable and explain each decision, which is useful material for the thesis.

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
- **Implementation (2026-10-02):** Battle menu option "AI timing: Real-time / Paused". In Paused mode the simulation does not advance while any AI request (Jev or LLM) is open; rendering continues and the control bar shows "waiting for AI…". Tested with slow fake AIs (Jev 0.5 s, LLM 1.5 s asked at the same moment): over 6 s of real time, Real-time advanced 5.7 s of battle and never waited; Paused advanced 4.1 s and froze ~1.7 s until both answers had arrived. Every AI answer is logged with its response time.

#### D5: Maps
- **Options:** (a) a fixed map only, (b) random maps only, (c) fixed map + random map + save option.
- **Chosen:** (c).
- **Why:**
  - A fixed map makes matches comparable.
  - Random maps test whether a strategy works in general and not just on one map.
  - "Save map" lets any map (including a random one) be loaded again, so the same map can be used for many matches in an experiment.
- **Implementation:** the menu has a Map option (Random / Fixed / Saved) and the control bar a "Save Map" button. The fixed map was generated once with the normal terrain preset and is stored in the code, so it never changes. Saved maps are kept in the browser's local storage as compact text (~7 KB per map). Restart keeps the chosen map. Note: only the terrain is fixed; unit start positions are still random.

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

#### D20: Revised command set and the command interface
- **Replaces:** D14's command set.
- **Options:** (a) keep D14 (including flank left/right), (b) drop flanking.
- **Chosen:** (b). The commands are:

| Command | What the hero does |
|---|---|
| Move (sector) | Goes to the given sector (e.g. D4) |
| Hold | Stays where it is and defends |
| Retreat | Falls back toward its own side |
| Attack | Moves to the nearest enemy |
| Attack hero (1–3) | Moves to a specific enemy hero |
| Continue LLM order | Jev only (D15): keep following the LLM's latest command |

- **Why:**
  - Flanking only makes sense if attacking from the side is better than from the front. Units in this simulation have no facing, so damage is the same from every direction and a flank would just be a longer walk. It can come back if a direction system is added later.
  - "Attack hero" stays: a hero's death removes its charisma bonus, so its soldiers lose courage and may flee. Targeting a hero is a real tactical choice.
  - D14's rule still holds: no command can change courage.
- **Command interface:** user right-clicks, Jev and the LLM all give orders through one function (`issueCommand`). The hero behaves the same whoever gave the order, and the hero remembers who gave the last command and the LLM's latest command (needed for D15).
- **Implementation:** each frame a hero's command is turned into a destination (moving targets such as "nearest enemy" are re-evaluated). Sectors: 10×10, A–J left to right, 1–10 top to bottom, 15×15 tiles each. Move targets that cannot be reached (inside mountains or in pockets enclosed by mountains) are moved to the closest reachable tile. Headless tests pass for every command, including Jev overriding the LLM and then resuming it with "continue LLM order".

#### D21: Jev layer, first version (proposed)
- **Status:** Proposed. Implemented so it can be tested; details to be confirmed or changed after trying it with a real API key.
- **How it works:** in Battle mode the enemy side can be set to "Jev" in the menu. Every 4 s, one request is sent for all of that side's heroes. Each hero gets one Choice question; the answer is applied through the command interface (D20) with source "jev".
- **What Jev sees per hero (D16, Q3):**
  - HP, status (standing / moving / fighting / retreating / resting), sector
  - current order and who gave it, the LLM's latest order
  - allies and enemies within 15 tiles: counts, how many are fleeing, average ally courage
  - nearest enemy (distance and direction), visible enemy heroes
  - a 15×15 text map centred on the hero (each character = 2×2 tiles: hero, enemies, allies, terrain)
  - Size: about 1,400 tokens for three heroes.
- **Options per hero (D20):** hold, retreat, attack, attack enemy hero N (living ones), continue LLM order (only when the LLM has given one), and move to the hero's own sector or one of the 8 neighbouring sectors.
  - Moves are limited to neighbouring sectors because Jev decides locally; map-wide moves are the LLM's job.
- **Confidence gate:** answers with confidence below 0.4 are ignored and the hero keeps its current order.
- **Overlapping requests (Q7):** if a new request is due while the previous one is still open, it is skipped and counted.
- **Errors:** if Jev cannot be reached (no key, network error), the enemy heroes switch to rule-based control and the game continues.
- **Logging:** every decision is recorded with time, hero, choice, confidence, whether it was applied, and response time (for Q13 and the latency experiments).
- **Tested so far:** with a fake Jev (request shape, decisions applied, low confidence ignored, overlap skipping, fallback). The proxy reaches TypeSafe's API and gets "API key required", so it only needs a key.

#### D22: LLM layer, first version (proposed)
- **Status:** Proposed. Implemented and tested end-to-end; details open for discussion.
- **Where it runs (D10):** inside the Vite dev server as a small plugin (`/api/llm`) that uses the Claude Agent SDK with the developer's Claude login. One persistent, lean session per side (custom system prompt, no tools, no project settings). A new match starts a new session, so the LLM remembers decisions within a match only (in-match memory, D11 option b).
- **How often:** every 20 s, first decision at the start of the match.
- **What the LLM sees (D16, Q4):** time; its heroes (sector, HP, status, current order and who gave it, Jev's last decisions for that hero); enemy heroes; army totals with fleeing counts and average courage; soldiers per sector for both sides; dominant terrain per sector as a 10×10 text grid. About 380 tokens.
- **What it answers:** one JSON object, `{"plan": "...", "orders": [{"hero": 1, "command": "move", "sector": "D4"}, ...]}`. Commands: move (any sector), hold, retreat, attack, attack_hero. Every order is checked (hero exists, sector valid, target alive) before it is applied through the command interface (D20) with source "llm". Invalid orders are logged and skipped.
- **Model:** Sonnet by default (fastest in R2), changeable with the `LLM_MODEL` environment variable.
- **Opponent options in the menu:** Rules, Jev, LLM, Jev + LLM. Offering every combination makes it possible to compare the layers on their own and together (ablation for the thesis). With both layers, Jev also sees the LLM's latest order and the LLM sees Jev's recent decisions (D15).
- **Errors:** if the LLM cannot be reached, it stops; if it was the only AI layer, the heroes switch to rule-based control.
- **End-to-end test (2026-10-02):** headless battle, enemy side commanded by the LLM, real dev server, Sonnet:

| Time | Latency | Plan (from the LLM) | Orders |
|---|---|---|---|
| 0 s | 6.50 s (session start) | Concentrate heroes centrally in I6 to fight together | move I5 / I6 / I7 |
| 20 s | 1.72 s | Hold a tight defensive line and let the enemy come | hold ×3 |
| 40 s | 1.60 s | Keep holding the line together | hold ×3 |
| 60 s | 2.08 s | Enemy hero 2 has pushed ahead of its allies, converge to kill it | attack_hero 2 ×3 |

  - 0 invalid orders. Latency after the first call matches R2 (~1.3–2.3 s). The first call includes starting the session; it could be started before the match begins.
  - The plans are coherent and react to the situation (e.g. targeting an isolated enemy hero).

#### D23: Win condition
- **Chosen:** in Battle mode, the side that loses all its units (heroes and soldiers) first loses. If both die in the same step it is a draw. The simulation then stops and shows the winner, the time and the units left.
- **Why:** simple and unambiguous, and needed before any experiment can be run. Objectives (D12) can change this later.
- **Spawning and patrol with AI:** Battle mode has no waves. Random patrol is only used by the rule-based opponent; heroes commanded by Jev or the LLM only move on AI orders (they fall back to rules only if the AI cannot be reached).
- **Test (headless, fixed map, 8 matches, west heroes ordered to "attack", east rule-based):** every match ended, after 130–286 s. Hunting down the last few fleeing units took at most ~1 minute. West won 8 of 8: the rule-based opponent (random patrol, charge when an enemy is seen) is a weak baseline.

#### D24: Code organization
- **Context:** after the AI layers were added, `SimulationEngine.ts` had grown to ~980 lines mixing rules, commands, rule heroes, the reflex and match end, and the design rules (D14, D19, D20) lived only in this document.
- **Options considered:** (a) leave as is; (b) split the engine into sibling modules; (c) also move the headless tests into the repository; (d) document conventions in one root `CLAUDE.md` or in one per folder.
- **Chosen:**
  - **Engine split (b):** `SimulationEngine` stays the owner of the loop; parts move to sibling files in `src/engine/`: `HeroCommands` (command interface, D20), `RuleHeroes`, `HeroReflex` (D18), `GroupPatrol`, `UnitHelpers`. The engine went from ~980 to ~710 lines. Behavior is unchanged: all headless checks were re-run after the split and pass.
  - **Conventions:** a root `CLAUDE.md` with the architecture, the rules that must not be broken (all orders through `issueCommand`, courage only computed by the engine, reflexes first, Classic keeps Phase 1 behavior, scoped AI inputs, no API keys in the browser) and how to run the project; plus a short `CLAUDE.md` in each folder (`src/engine`, `src/ai`, `src/state`, `src/rendering`, `src/ui`, `server`).
  - **Formatting:** Prettier and ESLint run on the non-UI code (0 lint warnings). UI files that are being changed in parallel on `main` were left untouched to avoid merge conflicts.
  - **Tests (c) not chosen:** the headless checks stay outside the repository, by the author's decision.

#### D26: AI inputs, version 2 (replaces D21 and D22)
- **Why:** the first LLM vs LLM match showed similar, repeated decisions, and the LLM prompt missed key rules (no win condition, courage only described in words, charisma not stated as a courage bonus, nothing about the 15-tile follow range or the hero reflex). R5 shows that game AIs and successful LLM agents get computed summaries, not raw data.
- **Rulebook (`src/ai/GameRules.ts`):** built from the engine's own constants (`src/engine/Rules.ts`), so the text always matches the simulation. Contents: goal (win condition), map and sectors, unit stats, the follow range (15 tiles), the full courage formula, charisma as +20 **courage** (not damage) within 10 tiles, rest, the hero survival reflex, terrain, and the exact meaning of each order.
  - The LLM gets it once per match as its system prompt; the Jev paragraph is included only when Jev runs on the same side.
  - Jev has no memory, so it gets the relevant part (no goal or stance) as `game_rules` inside every request's state, as Jev's documentation recommends for domain rules.
- **Locations:** each sector is split 3×3 into 5×5-tile sub-sectors (`D4-NE`), so the LLM can aim at a 5-tile area instead of a 15-tile sector.
- **Orders:** `attack_hero` kept, with a precise definition (follows the enemy hero; hero and soldiers still fight everything on the way). Flanking stays removed (D20).
- **LLM report (every 20 s), computed by code:** its previous stance, plan and their age; per own hero group: sub-sector, hero HP and status, current order and source, soldiers following, change since last report, average HP and courage, fleeing, local force ratio, and Jev's assessment when Jev runs; the same group stats for enemy heroes; army totals with losses since the last report and the force ratio (total HP) now and at the last report; events (heroes killed, reflex retreats); occupied sectors with per-side counts, average HP and courage and who controls them; terrain per sector.
- **LLM reply:** situation → change → stance → plan → orders (structured reasoning order, R5). Stances: aggressive / defensive / regroup, each with an explicit switch condition (MASMP-style state machine, R5): defensive below 70% of the enemy's total HP, aggressive above 120% or after 60 s of enemy passivity, regroup after heavy losses.
- **Jev request (every 4 s):** `game_rules`; per hero: HP, status, sub-sector, current order, the LLM's order and its age, its own previous decision, group stats, nearby allies and enemies, local force ratio and its value 4 s earlier, nearest enemy, enemy heroes within 30 tiles, 15×15 local text map. Options, each with "what" and "not for": continue LLM order (only when one exists), hold, retreat, attack, attack enemy hero N (within 30 tiles), and 8 short steps of ~10 tiles. Plus three assessment questions per hero: surrounded (yes/no probability), threat level (0–3), and whether the LLM's order still fits (only when one exists). The assessments do not change Jev's choice; they are logged and sent up to the LLM (R5: lower layers report up). Size ≈ 3,200 tokens per request for three heroes (≈ $0.01 per match).
- **Tested** with a fake Jev and a fake LLM (request contents, parsing, sub-sector moves, stance memory, assessments reported up). A real LLM vs LLM comparison with v1 is still to be run.

#### D27: Fighting and breaking off (battle mode)
- **Problem:** a hero with an enemy within 2 tiles switched to attack and never moved until the fight ended. A "retreat" or "move" order from the user, Jev or the LLM had no effect during a fight; only the survival reflex could pull the hero out.
- **Options considered:**
  - (a) movement orders always ignore enemies (pure "move" as in RTS games): the hero would march straight into the next enemy group and die.
  - (b) attack while walking: no cost to leaving a fight; rejected.
  - (c) a separate "disengage" order: a bigger order set for the AI to learn.
  - (d) context rule, adapted from RTS move / attack-move.
- **Chosen:** (d):
  - A move order given while **not** fighting: the hero advances, fights enemies it meets on the way (with its soldiers), then continues to its target.
  - A **different** movement order given **while fighting**: the hero breaks off and ignores enemies **only until none is within 6 tiles**, then behaves normally again, so it does not march into the next enemy group.
  - Retreat always breaks off.
  - **A repeated order is not a new order:** the LLM restates its orders every 20 s, and without this rule every restatement would pull heroes out of their fights. Identical orders are ignored by the command interface.
  - The survival reflex (D18) still comes first; an order received during the reflex is kept and carried out afterwards.
  - Soldiers do not break off with the hero; they keep fighting by their own rules (D14). Leaving them costs their charisma bonus (beyond 10 tiles) and their following (beyond 15 tiles): a real trade-off for the AI.
  - Classic mode keeps Phase 1 behavior (D19).
- **Rulebook:** both layers are told this rule in about 80 tokens (built from `DISENGAGE_CLEAR_RADIUS` in `Rules.ts`).
- **Research basis:** RTS games separate "move" (ignore enemies, used to escape) from "attack-move" (engage on the way); breaking off is meant to be temporary; the tactical layer (Jev, every 4 s) is what avoids walking into enemy groups, as squads do in Killzone 3 (R5). Threat-aware pathfinding (avoiding enemy-dense areas in A*) was noted as a possible later addition.
- **Tested (headless):** a repeated order keeps the hero fighting; a different move order breaks it off, it never attacks while breaking off, and it returns to normal after 3.5 s once clear; retreat always breaks off; Classic is unaffected.

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
- **Implementation and tuning (2026-10-02):**
  - First version: retreat at HP < 30%, or when enemies ≥ 5 and ≥ 3× allies in sight; the hero ran to the centre of its own soldiers. Testing showed two problems: by the time HP is at 30%, a hero hit by several enemies dies within a second; and the soldiers' centre can be inside the fight, so the hero ran into it.
  - Final version: retreat at HP < 50% (resume at 80%), or when enemies ≥ 5 and ≥ 2× allies in sight. The hero moves away from nearby enemies and back toward its own side (its start position).
  - **Measured effect** (headless, fixed map, friendly heroes ordered to attack, 20 matches of 180 s per condition): hero deaths **80/120 without the reflex vs 52/120 with it (35% fewer)**.
  - Most remaining deaths are heroes whose whole army is gone: alone, chased by 60–75 enemies and cornered at the map edge. That is a lost battle, not a reflex failure.

#### D19: Classic and Battle modes, equal stats in Battle
- **Options:**
  - (a) replace the Phase 1 game with the symmetric setup
  - (b) keep the Phase 1 game as "Classic" and add the symmetric setup as a new "Battle" mode
- **Chosen:** (b).
- **Why:**
  - Phase 1 keeps working and can still be shown in the thesis. Nothing that works is broken.
  - Battle mode is the base for User vs Agent and Agent vs Agent (D3).
- **Battle mode setup:**
  - 3 heroes + 150 soldiers per side, no waves.
  - Soldiers follow the nearest hero of their side and use courage (D13, D14).
  - Enemy heroes without AI are rule-based: charge a visible enemy, otherwise patrol like a berserker group (same behavior as Phase 1 berserkers).
  - **Both sides use the same unit stats** (warrior values). Then the result depends only on how each side is commanded, which keeps AI comparisons fair. Classic mode keeps its original stats.
- **Implementation:** commit `dfc0df3` (branch `phase2/symmetry`). Headless test: soldiers stay 1–2 tiles from their hero; the hero reflex (D18) triggered 20 times in a 240 s battle with no hero deaths; spawning checked on 600 random maps.


#### D25: Sprite pack for units
- **Context:** Visual polish work on the renderer (hit flash, death animation, blood, status icons, hero aura, sprites, loading screen), tracked in `UI_PLAN.md`. All of it is rendering-only: the simulation engine is not changed, and every effect can be switched off (FX toggle) so measurements stay comparable with Phase 1.
- **Need:** one sprite each for warriors and berserkers, plus 6 hero sprites (3 per side, see D13).
- **Options (see R4):**
  - (a) Ninja Adventure (Pixel-boy), CC0
  - (b) Tiny Swords (Pixel Frog), free but not CC0
  - (c) Kenney Tiny Dungeon / Roguelike Characters, CC0
  - (d) draw simple sprites in code
- **Chosen:** (a).
- **Why:**
  - CC0: the files can go into the public GitHub repo and the public demo with no license risk. Tiny Swords forbids redistributing the files, which a public repo would do.
  - Top-down view and 16×16 size fit the map. At full-map zoom units are only 10 px, so large art (Tiny Swords, 192 px) would lose its detail anyway.
  - Includes walk and attack animations; Kenney's characters are static.
  - Team colors are applied by tinting when the sprites are loaded, so characters are chosen by silhouette, not color.
- **Note:** At full-map zoom units stay squares; sprites are drawn only when zoomed in (performance and readability).

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


### R4: Sprite packs for units (2026-10-02)

**Question:** Which free pixel art pack fits the simulation's units (top-down, small size, animated) and can be used in a public repository?

| Pack | License | Style | Animations | Issue |
|---|---|---|---|---|
| Ninja Adventure (Pixel-boy) | CC0 | Top-down, 16×16, 50+ characters, 30+ monsters | Walk, attack, special poses | Ninja/samurai theme |
| Tiny Swords (Pixel Frog) | Free for personal and commercial use; **no redistribution** of the files | 192 px characters, faction colors included | Yes | Public repo = redistribution; detail lost at 10–20 px |
| Kenney Tiny Dungeon / Roguelike Characters | CC0 | 16×16 | None (static) | No animation |
| Drawn in code | n/a | Matches current square style | Any | Less polished |

**Format check (Ninja Adventure):** three character sheets from the official example repository were downloaded and inspected. Each is a 64×112 PNG: 4 columns (facing down, up, left, right) × 7 rows of 16×16 frames (idle, 4-frame walk, attack, special poses). Only left/right are needed; left can be a mirror of right.

**Findings:**
- ✅ Ninja Adventure is CC0, top-down and animated: the only option that meets all three needs.
- ⚠️ Tiny Swords looks best, but its license forbids redistributing the files.
- ⚠️ Licenses are as stated on the pack pages (2026-10-02).

**Conclusion:** Ninja Adventure (D25).

**Sources:**
- [Ninja Adventure Asset Pack](https://pixel-boy.itch.io/ninja-adventure-asset-pack), [example repository](https://github.com/pixel-boy/NinjaAdventure)
- [Tiny Swords](https://pixelfrog-assets.itch.io/tiny-swords)
- [Kenney Tiny Dungeon](https://kenney.nl/assets/tiny-dungeon), [Kenney Roguelike Characters](https://kenney.nl/assets/roguelike-characters)

### R5: How game AIs and LLM agents represent the battlefield (2026-10-03)

**Question:** What should Jev and the LLM receive as input: raw data (unit lists, screenshots) or a summary? How do commercial game AIs and LLM game agents do it?

**Trigger:** in the first LLM vs LLM match both sides kept similar, repeated orders (heroes grouped close together, "keep holding the line"), and the LLM prompt was found to miss key rules (win condition, courage numbers, the 15-tile follow range, the hero reflex).

**Commercial game AI:**
- **Killzone 3 (Guerrilla Games):** multiplayer bots use a three-layer hierarchy: a commander plays the game mode and gives objectives, squads turn objectives into orders, individual bots carry them out. Each layer controls the one below and information flows back up. Uses influence maps and an HTN planner. This matches our design almost one to one: LLM ≈ commander, Jev ≈ squad (hero), Phase 1 rules ≈ individual bots. Bots overriding orders to survive mirrors D14/D18; a new order replacing the old one mirrors D15. ✅ verified (Game AI Pro, ch. 29).
- **Total War:** battle AI reportedly based on a set of rules inspired by Sun Tzu, triggered by force ratios (e.g. surround when heavily superior, attack directly when clearly superior). ⚠️ exact figures not yet verified.
- Common to behavior trees (Halo 2), HTN planners (Killzone) and utility AI: first evaluate the situation with code, then choose.

**LLM game agents:**
- **TextStarCraft II (Ma et al., 2023):** game state is converted to text by code and summarized (single-frame, then multi-frame "Chain of Summarization"); most tested LLMs beat the level-5 built-in AI. Adding screenshots to text made GPT-4o perform worse. A structured reasoning order (summary → analysis → opponent → plan → decision) is reported to matter a lot (⚠️ the exact 50% vs 0% ablation figure is not yet verified).
- **MASMP (2025):** plain prompts led to invented actions, greedy short-term choices and inconsistent decisions between calls. Giving the LLM explicit strategy states with transition rules, plus a small memory of the current tactic carried into every call, raised the win rate against the hardest built-in AI (level 7) from 0% to 60%. ✅ verified (arXiv 2510.18395).
- **Adaptive Command (2025):** the LLM adjusts parameters of a behavior tree instead of issuing low-level actions, similar to "LLM sets the plan, lower layers execute".
- **Vision models (OmniSpatial and others, 2025):** best models reach ~57% on spatial reasoning, struggle with small, dense objects; structured intermediate representations improve results.
- **Jev documentation:** keep control flow in code, ask atomic questions, put only relevant information in the state, describe similar options with what/not-for, route low-confidence answers elsewhere.

**Findings:**
- ✅ Code should compute, the AI should judge: force ratios, sector control, trends and recent losses are computed by code; raw unit lists and screenshots are not given.
- ✅ Each layer sees its own scale (already D16).
- ✅ Keep the current plan and its reason in memory and pass it with every call, to avoid flip-flopping and inertia.
- ✅ Lower layers report upward (Jev decisions, events such as hero killed, retreat, heavy losses).
- ✅ Commands and rules must be stated precisely (e.g. the charisma bonus is +20 courage within 10 tiles, not a damage bonus).
- ⚠️ A structured reasoning order makes replies longer and slower; to be measured.

**Conclusion:** redesign both inputs as computed summaries: the LLM gets a complete rulebook (win condition, courage formula, charisma, follow range, reflex, decision interval) plus a per-sector table with computed values, hero and group status, recent events and its previous plan; Jev gets local force ratio and trend, the LLM order and its age, and its own previous decision. Whether summaries beat raw data can itself be an experiment (ablation, as in TextStarCraft II).

**Sources:**
- [Hierarchical AI for Multiplayer Bots in Killzone 3 (Game AI Pro, ch. 29)](http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter29_Hierarchical_AI_for_Multiplayer_Bots_in_Killzone_3.pdf)
- [Large Language Models Play StarCraft II: Chain of Summarization (Ma et al.)](https://ar5iv.labs.arxiv.org/html/2312.11865)
- [Memory-Augmented State Machine Prompting (MASMP)](https://arxiv.org/html/2510.18395v1)
- [OmniSpatial: spatial reasoning benchmark for VLMs](https://arxiv.org/html/2506.03135v2)
- [TypeSafe documentation](https://docs.typesafe.ai/llms.txt)
- Also found in the search, not yet read: The Road to War: The AI of Total War (Game Developer); Killzone's AI: Dynamic Procedural Tactics (GDC Europe 2005); Adaptive Command (2025); A Survey on LLM-Based Game Agents.

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
- **Status:** Workaround (2026-10-02): local development uses a Vite dev-server proxy that adds the key server-side; verified to reach TypeSafe's API. Vercel deployment (D8) still to do.

---

## Open questions

| # | Question | Notes / current thinking |
|---|---|---|
| Q1 | What command set will layers 2 and 3 control? | Answered by D13, D14 |
| Q2 | How do layers 2 and 3 interact when they disagree? | Answered by D15 |
| Q3 | What surrounding information is passed to Jev? | Proposed in D21: hero status, current and strategic order, nearby ally/enemy counts and courage, nearest enemy, visible enemy heroes, 15×15 local text map. To be redesigned per R5 (local force ratio and trend, LLM order and its age, previous decision) |
| Q4 | How is the full map summarized for the LLM? | Proposed in D22: heroes of both sides, army totals and courage, soldiers per sector, terrain per sector as a 10×10 text grid (~380 tokens). To be redesigned per R5 (complete rulebook, computed per-sector values, recent events, previous plan) |
| Q5 | Proxy hosting for the live demo | Answered by D8 (Vercel) |
| Q6 | Real-time mode: how does the speed multiplier interact with latency? | Answered by D4: speed setting stays; at higher speed more game time passes before an answer arrives. Response times are recorded |
| Q7 | Real-time mode: a new decision is due but the previous one hasn't arrived | Proposed in D21 (Jev): skip it and count skipped requests |
| Q8 | Does the latency mode apply to both AI layers? | Answered by D4: yes, both Jev and the LLM |
| Q9 | Agent vs Agent: same model on both sides, or different models? | Suggestion: both. A mirror match is the control experiment. |
| Q10 | Does wave spawning stay in the symmetric setup? | If D12 is adopted: waves become symmetric reinforcements from each side's base |
| Q11 | Which metrics will the thesis report? | Win rate, casualties, survival time, decision latency, skipped decisions, cost. Requires headless mode and export. |
| Q12 | How should the layer 2 decision frequency relate to Jev latency (~0.3–0.7 s)? | Proposed in D21: every 4 s, one request per side for all its heroes. Still to measure with a real key (Q13) |
| Q13 | What are Jev's real end-to-end latency and token cost per call? | Needs an API key; measure inside the simulation (R1, R3) |
| Q14 | How large is the Vercel cold start in practice? | Measure after deployment (D8) |
| Q15 | Is cross-match learning (D11) feasible, and how should it be built? | Research: lesson format and size limit, summarizing old lessons, effect of a fixed vs varied map (risk of map-specific lessons), fairness in Agent vs Agent, keeping other experiments independent (learning off). Related work: Reflexion (Shinn et al., 2023) |
| Q16 | Does the persistent LLM session slow down as history grows over a match? | Repeat R2 measurement over a full-length match; reset the session periodically if needed |
