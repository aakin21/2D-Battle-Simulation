import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { HeroCommands } from './HeroCommands';
import { GroupPatrol } from './GroupPatrol';
import { separateUnits } from './Separation';
import { updateHeroStand } from './HeroPosition';
import { updateWaves } from './ClassicWaves';
import { updateRuleHeroes } from './RuleHeroes';
import { updateControl, damageBases, objectiveEnd, EndReason, wholePoints } from './Objectives';
import { Followers, updateCourage } from './Soldiers';
import { updateBehavior } from './Behavior';
import { moveUnit } from './Movement';
import { processCombat, processRest, removeDeadUnits } from './Combat';
import { SIM_STEP, STEPS_PER_SECOND } from './Rules';
import {
  IHero,
  IBattlefield,
  Faction,
  HeroCommand,
  CommandSource,
  AITiming,
  SimConfig,
  DEFAULT_CONFIG,
} from '../types/types';

// Simulation speeds the user can choose
export const SPEED_STEPS = [0.5, 1, 2, 4] as const;
export type SpeedStep = (typeof SPEED_STEPS)[number];

// The fixed-step loop (P9; "Fix Your Timestep", Glenn Fiedler). Each frame adds the real time
// since the last frame times the speed to an accumulator and runs one step of SIM_STEP (Rules.ts)
// per whole step it holds; the rest waits for the next frame.
// A frame counts as at most this much real time: a longer one (a hitch, a breakpoint, the first
// frame after a hidden tab) is not caught up, the game runs slower for it, as Phase 1's loop did
// with the same 0.1 s. Catching up more would follow a long frame with another long one.
export const MAX_FRAME_SECONDS = 0.1;
// Steps one frame may run (the spiral of death: frames that take longer ask for more steps,
// which take longer still). 4x at 60 Hz needs 4 a frame, at 30 Hz 8; 12 keeps 4x on time down to
// 20 frames a second. Beyond that the time owed is dropped: the game runs slower than asked, the
// simulation itself is unaffected.
export const MAX_STEPS_PER_FRAME = 12;
// Where the accumulator starts, and what it is set back to when the time owed is dropped: a
// quarter step, so frames that each bring a whole or half number of steps (60 Hz at any speed but
// 0.5x, 30 Hz, 120 Hz at 1x, 60 Hz at 0.5x) keep a remainder a quarter step away from a step's
// edge, where the frames' jitter would make some run no step and the next two
const ACCUMULATOR_START = SIM_STEP / 4;

// The simulation time a step that begins at `t` ends at, on the step grid (k / STEPS_PER_SECOND,
// so 480 s is 28 800 steps exactly; a time set by hand is taken to the nearest step first)
function nextStepTime(t: number): number {
  return (Math.round(t * STEPS_PER_SECOND) + 1) / STEPS_PER_SECOND;
}

// An AI layer that gives heroes orders (Jev or the LLM). Ticked every simulation step.
export interface AIController {
  tick(elapsed: number): void;
  isWaiting(): boolean; // a request is open and its answer has not arrived yet
  // The match is over for this controller: stop asking, and ignore answers still on the way,
  // so they cannot reach the heroes of the next match
  dispose(): void;
}

// Battle mode result: the side whose units (heroes and soldiers) all die first loses, or the
// match ends on its objective or time limit (D30).
export interface MatchResult {
  winner: Faction | null; // null: draw
  time: number; // simulation seconds
  survivors: number; // units left on the winning side
  reason: EndReason; // how the match was decided (D30)
  scores?: { friendly: number; enemy: number }; // control mode
}

export class SimulationEngine {
  private stateManager: StateManager;
  private renderer: Renderer;
  private minimapRenderer: MinimapRenderer;

  private patrol = new GroupPatrol();
  private commands: HeroCommands;

  private followers = new Followers();
  // Reused buffer for courage counts: [friendly, enemy]
  private factionCounts = new Int32Array(2);
  private paused: boolean = false;
  private stressMode: boolean = false;
  private battleMode: boolean = false;
  private controllers: AIController[] = [];
  private result: MatchResult | null = null;
  private aiTiming: AITiming = 'realtime';
  private onMatchEnd: ((result: MatchResult) => void) | null = null;
  // An exception in a simulation step stops the run; it is kept and shown until a restart
  private error: string | null = null;
  private onError: ((message: string) => void) | null = null;
  private lastDrawError: string | null = null;
  private speedMultiplier: number = 1;
  private waveMultiplier: number = 1;
  private lastConfig: SimConfig = DEFAULT_CONFIG;
  // The last frame's timestamp (ms); null until the first frame after start() sets it
  private lastTime: number | null = null;
  // Simulation seconds owed to the run and not stepped yet (less than a step between frames)
  private accumulator: number = ACCUMULATOR_START;
  private rafId: number = 0;
  // UI-only hooks: an observer after each simulation step (the replay recorder) and another
  // battlefield to draw instead of the live one (a replay being watched). Neither changes the run.
  private onStep: (() => void) | null = null;
  private viewSource: (() => IBattlefield) | null = null;

  constructor(stateManager: StateManager, renderer: Renderer, minimapRenderer: MinimapRenderer) {
    this.stateManager = stateManager;
    this.renderer = renderer;
    this.minimapRenderer = minimapRenderer;
    this.commands = new HeroCommands(stateManager);
  }

  setOnStep(fn: (() => void) | null): void {
    this.onStep = fn;
  }

  // Draw this battlefield instead of the live one (null: the live one again)
  setViewSource(fn: (() => IBattlefield) | null): void {
    this.viewSource = fn;
  }

  // The first frame after start() only sets the time base: its timestamp can be from before
  // start() ran, and the time before it is no time the run was shown
  start(): void {
    this.lastTime = null;
    this.accumulator = ACCUMULATOR_START;
    this.rafId = requestAnimationFrame(this.loop.bind(this));
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
  }

  pause(): void {
    this.paused = true;
  }

  // A run stopped by an error stays paused: its state may be half-updated
  resume(): void {
    if (!this.error) this.paused = false;
  }

  togglePause(): void {
    if (!this.error) this.paused = !this.paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setSpeed(multiplier: SpeedStep): void {
    this.speedMultiplier = multiplier;
  }

  getSpeed(): number {
    return this.speedMultiplier;
  }

  increaseSpeed(): void {
    const idx = SPEED_STEPS.indexOf(this.speedMultiplier as SpeedStep);
    if (idx < SPEED_STEPS.length - 1) this.speedMultiplier = SPEED_STEPS[idx + 1];
  }

  decreaseSpeed(): void {
    const idx = SPEED_STEPS.indexOf(this.speedMultiplier as SpeedStep);
    if (idx > 0) this.speedMultiplier = SPEED_STEPS[idx - 1];
  }

  applyConfig(config: SimConfig): void {
    this.lastConfig = config;
    this.waveMultiplier = config.waveMultiplier;
    this.aiTiming = config.aiTiming ?? 'realtime';
  }

  // D4 paused mode: the simulation does not advance while an AI answer is pending. The step in
  // which a layer asks is completed, and is the last until the answer is in (advance()).
  isWaitingForAI(): boolean {
    return this.aiTiming === 'paused' && this.controllers.some((c) => c.isWaiting());
  }

  isBattleMode(): boolean {
    return this.battleMode;
  }

  isStressMode(): boolean {
    return this.stressMode;
  }

  getResult(): MatchResult | null {
    return this.result;
  }

  setOnMatchEnd(cb: (result: MatchResult) => void): void {
    this.onMatchEnd = cb;
  }

  getError(): string | null {
    return this.error;
  }

  setOnError(cb: (message: string) => void): void {
    this.onError = cb;
  }

  // AI controllers for the current match; cleared on every restart.
  setControllers(controllers: AIController[]): void {
    for (const c of this.controllers) if (!controllers.includes(c)) c.dispose();
    this.controllers = controllers;
  }

  // The AI controllers of the current match (a layer finds the other layers of its side)
  getControllers(): readonly AIController[] {
    return this.controllers;
  }

  // Entry point for hero orders from outside the frame (D20): user clicks, Jev and the LLM. Rule
  // heroes give theirs inside the frame through the same HeroCommands.issue (without breaking
  // off a fight, D27), so a hero behaves the same whoever gave the order.
  issueCommand(hero: IHero, command: HeroCommand | null, source: CommandSource): void {
    this.commands.issue(hero, command, source, this.battleMode);
  }

  restart(): void {
    this.restartRun(false);
  }

  restartStressTest(): void {
    this.restartRun(true);
  }

  // A new run with the last config, or the stress test (classic rules, default config)
  private restartRun(stress: boolean): void {
    this.stop();
    this.stressMode = stress;
    this.stateManager.setStressMode(stress);
    if (stress) this.stateManager.reset();
    else this.stateManager.reset(this.lastConfig);
    this.setControllers([]);
    this.result = null;
    this.error = null;
    this.battleMode = stress ? false : this.stateManager.isBattleMode();
    this.renderer.setBattleMode(this.battleMode);
    this.patrol.clear();
    this.commands.reset();
    this.paused = false;
    this.speedMultiplier = 1;
    this.start();
  }

  // One simulation step of SIM_STEP, as the loop runs it: the step, the clock to the step's end,
  // then the step's observer (the replay recorder). Headless runs (the smoke tests, experiments)
  // call it to run the very steps the browser runs. An exception is the caller's: the loop stops
  // the run with it, and the clock stays where the step began.
  step(): void {
    const bf = this.stateManager.getBattlefield();
    const end = nextStepTime(bf.elapsedTime);
    this.update(SIM_STEP, end);
    bf.elapsedTime = end;
    this.onStep?.();
  }

  // The step from the battlefield's time to `endTime`. The order matters: AI ticks and orders
  // come before behavior and movement, combat after movement, deaths after combat. The clock is
  // the caller's (step()).
  private update(
    deltaTime: number,
    endTime: number = this.stateManager.getBattlefield().elapsedTime + deltaTime
  ): void {
    const sm = this.stateManager;
    const battleMode = this.battleMode;
    const { units, grid, elapsedTime } = sm.getBattlefield();

    for (const controller of this.controllers) controller.tick(elapsedTime);
    if (battleMode) updateRuleHeroes(sm, this.commands, this.patrol);
    this.commands.applyAll();
    // D48: a hero with enemies near stands behind its soldiers (battle mode)
    if (battleMode)
      for (const hero of sm.getHeroes())
        updateHeroStand(sm, hero, this.commands.effective(hero), elapsedTime);

    for (const unit of units) updateCourage(sm, unit, battleMode, this.factionCounts);
    for (const unit of units) updateBehavior(sm, unit, battleMode);
    if (battleMode) this.followers.count(sm, units);

    // The spatial grid is synced after each move, from the position before it
    for (const unit of units) {
      const oldX = unit.position.x;
      const oldY = unit.position.y;
      moveUnit(sm, unit, deltaTime, grid, battleMode, this.patrol, this.followers);
      sm.syncPosition(unit, oldX, oldY);
    }
    // Battle mode: units take up room and push each other apart (classic keeps Phase 1, D19)
    if (battleMode) separateUnits(sm, units, deltaTime, grid);

    processRest(units, deltaTime);
    processCombat(sm, units, deltaTime);
    if (battleMode) {
      const mode = sm.getBattlefield().objective.mode;
      if (mode === 'control') updateControl(sm, deltaTime);
      if (mode === 'base') damageBases(sm, units, deltaTime);
    }
    removeDeadUnits(sm);
    if (battleMode) this.checkMatchEnd(endTime);
    // Classic berserker waves (ClassicWaves.ts); the stress test has none
    // Classic waves only: battle mode spawns no berserkers (D19)
    if (!this.stressMode && !battleMode) updateWaves(sm, sm.getBattlefield(), this.waveMultiplier);
  }

  // Ends the match when one side has no units left or on its objective or time limit (D30),
  // then freezes the simulation. Checked at the end of a step (`endTime`): the step that ends at
  // the time limit is the last, so nothing scores or acts past it (P9), and the result's time
  // is the clock the match stops at.
  private checkMatchEnd(endTime: number): void {
    if (this.result) return;
    let friendly = 0;
    let enemy = 0;
    for (const u of this.stateManager.getBattlefield().units) {
      if (u.faction === Faction.FRIENDLY) friendly++;
      else enemy++;
    }
    const bf = this.stateManager.getBattlefield();
    let winner: Faction | null;
    let reason: EndReason;
    if (friendly === 0 || enemy === 0) {
      winner = friendly > 0 ? Faction.FRIENDLY : enemy > 0 ? Faction.ENEMY : null;
      reason = 'elimination';
    } else {
      const end = objectiveEnd(this.stateManager, endTime);
      if (!end) return;
      ({ winner, reason } = end);
    }

    this.result = {
      winner,
      time: endTime,
      survivors: winner === Faction.FRIENDLY ? friendly : winner === Faction.ENEMY ? enemy : 0,
      reason,
      ...(bf.objective.mode === 'control'
        ? {
            scores: {
              friendly: wholePoints(bf.objective.scores.friendly),
              enemy: wholePoints(bf.objective.scores.enemy),
            },
          }
        : {}),
    };
    this.paused = true;
    this.onMatchEnd?.(this.result);
  }

  private loop(timestamp: number): void {
    this.frame(timestamp);
    this.rafId = requestAnimationFrame(this.loop.bind(this));
  }

  // One frame of the loop: the simulation steps this frame's time asks for (none while paused)
  // and the drawing, once, without asking for the next frame (the headless browser tests step a
  // run by hand with it)
  private frame(timestamp: number): void {
    this.advance(timestamp);

    // Drawing never changes the simulation, so a drawing error must not stop the run
    try {
      const battlefield = this.viewSource ? this.viewSource() : this.stateManager.getBattlefield();
      this.renderer.render(battlefield);
      this.minimapRenderer.render(
        battlefield,
        this.renderer.getCamera(),
        this.renderer.getTerrainArt()
      );
    } catch (err) {
      const message = String(err);
      if (message !== this.lastDrawError) console.error('Drawing failed:', err);
      this.lastDrawError = message;
    }
  }

  // The fixed step: the real time since the last frame (never negative, at most
  // MAX_FRAME_SECONDS) times the speed goes into the accumulator, and each whole step it holds
  // is run, at most MAX_STEPS_PER_FRAME. A paused run, or one waiting for an AI answer (D4),
  // takes no time in; the remainder of less than a step is kept for when it goes on. Whenever the
  // steps stop early (the step cap; the match ended, the run failed or, in paused AI timing, a
  // layer began waiting in the step just run) the time still owed is dropped, so it is never
  // caught up in a burst later.
  private advance(timestamp: number): void {
    const last = this.lastTime;
    this.lastTime = timestamp;
    const delta = last === null ? 0 : (timestamp - last) / 1000;
    // Not negative (a frame that began before the last one), not NaN
    const real = delta > 0 ? Math.min(delta, MAX_FRAME_SECONDS) : 0;

    if (this.paused || this.isWaitingForAI()) return;
    this.accumulator += real * this.speedMultiplier;

    let steps = 0;
    while (this.accumulator >= SIM_STEP) {
      if (steps === MAX_STEPS_PER_FRAME) break;
      try {
        this.step();
      } catch (err) {
        this.fail(err);
        break;
      }
      this.accumulator -= SIM_STEP;
      steps++;
      if (this.paused || this.isWaitingForAI()) break;
    }
    if (this.accumulator >= SIM_STEP) this.accumulator = ACCUMULATOR_START;
  }

  // An exception in a simulation step: the state may be half-updated, so the run stops here
  // instead of the whole page freezing. The UI shows the error; a restart starts a new run.
  private fail(err: unknown): void {
    this.error = err instanceof Error ? err.message : String(err);
    this.paused = true;
    console.error('Simulation stopped:', err);
    this.onError?.(this.error);
  }
}
