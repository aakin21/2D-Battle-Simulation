# Project Schedule
- 2026-03-01: Core Engine Skeleton
- 2026-03-08: Movement & Pathfinding (A*)
- 2026-03-15: Combat Core
- 2026-03-22: Morale & Courage System
- 2026-03-29: Flee & Rest Behavior
- 2026-04-05: Hero Control & Charisma System
- 2026-04-12: Wave Spawning & Berserker Behavior
- 2026-04-19: UI System & Controls
- 2026-04-26: Performance Optimization
- 2026-05-03: Testing & Bug Fixes
- 2026-05-10: Testing & Bug Fixes
- 2026-05-17: Final Documentation & Deployment

## Core Engine Skeleton
Setting up the project with TypeScript and Vite. The architecture separates four core components: a Simulation Engine for behavioral rules and combat logic, a Rendering Engine for Canvas visualization, a UI Controller for input handling, and a State Manager for data storage. The 150x150 grid system will support four terrain types generated procedurally. A base Unit class holds the core attributes, and the main simulation loop handles update and render cycles. By the end of this week the grid and some placeholder units should be visible on the HTML5 Canvas.

## Movement & Pathfinding (A*)
Units need to navigate the grid while respecting terrain. A* pathfinding with a Manhattan distance heuristic handles routing around impassable mountains. Terrain-based speed modifiers are applied here as well (Open: 1.0, Forest: 0.7, Swamp: 0.5, Mountain: impassable). Terrain may also influence other unit properties such as line of sight depending on final design decisions. Tackling pathfinding early is important because it is the most complex part and everything else builds on top of it.

## Combat Core
When two opposing units come within 2 tiles of each other, combat begins. Attacks happen every 1 second with simultaneous damage. Units are removed once their HP hits zero. HP bars appear above each unit for visual feedback.

## Morale & Courage System
Courage is the central mechanic of the simulation. It reacts dynamically to wounds, the ally/enemy ratio within line of sight, and hero proximity. Units continuously evaluate their surroundings to determine threat levels and numerical superiority. This system drives the emergent crowd behavior that the thesis is built around.

## Flee & Rest Behavior
When courage drops below a threshold, a unit disengages and moves away from danger at 1.5x speed. Wounded units (HP < 50) that find themselves in a safe area enter a rest state, regenerating HP at 10/sec and recovering courage gradually. Once healed or if enemies approach, they re-enter the fight. This completes the full behavior cycle: IDLE → ATTACK → FLEE → REST → IDLE.

## Hero Control & Charisma System
Heroes are the units the user can directly command by setting a task point with right-click. Warriors within the hero's charisma radius are drawn toward that task point, which serves as the main crowd control mechanism. The hero's charisma also provides a courage bonus to nearby warriors. Warrior movement still respects combat and flee priorities over attraction.

## Wave Spawning & Berserker Behavior
Enemy berserker hordes appear in waves: 100 at 30s, 150 at 90s, 200 at 180s, followed by sustained spawning of 40-60 every 20-40 seconds. They spawn at the map edges and move toward the nearest opponent. Spawn limits (max 1000 total units, max 900 berserkers) keep performance in check. By the end of this week the full simulation loop should be working end-to-end.

## UI System & Controls
The control bar provides play/pause, speed adjustment (0.5x/1x/2x/4x), a wave counter, and unit counts. An info panel shows details of a selected unit, and a minimap gives an overview of the battlefield. Keyboard shortcuts (Space: pause, +/-: speed, R: restart) and mouse interaction (left-click: select, right-click: hero command, hover: tooltip) round out the controls. A main menu provides options to start a new simulation, view instructions, and adjust settings. User preferences such as simulation speed are saved to LocalStorage so they persist between sessions.

## Performance Optimization
Profiling the simulation to hit 60 FPS with 500+ active units. Spatial partitioning reduces the cost of collision detection and environment sensing. Object pooling avoids frequent allocation during spawning and removal. Off-screen units are culled from rendering. The target is to keep simulation logic under 10ms per frame.

## Testing & Bug Fixes
Going through all behavior state transitions to catch edge cases. Verifying courage calculations, combat resolution, wave timing, and pathfinding correctness. Testing across Chrome, Firefox, Safari, and Edge to ensure cross-browser compatibility.

## Testing & Bug Fixes
Continued testing with high unit counts and long simulation runs. Stress-testing wave spawning at scale and making sure no state corruption occurs. The simulation needs to run reliably through full thesis demonstration sessions.

## Final Documentation & Deployment
Writing up project documentation that meets the university's thesis requirements. Deploying the final build to static hosting (GitHub Pages). Last pass on code quality, TypeScript strict mode, and overall cleanup before the presentation.
