import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { HeroCommands, runningCommand } from './HeroCommands';
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
  private lastTime: number = 0;
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

  start(): void {
    this.lastTime = performance.now();
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

  // D4 paused mode: the simulation does not advance while an AI answer is pending.
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
    this.paused = false;
    this.speedMultiplier = 1;
    this.start();
  }

  // One simulation step. The order matters: AI ticks and orders come before behavior and
  // movement, combat after movement, deaths after combat.
  private update(deltaTime: number): void {
    const sm = this.stateManager;
    const battleMode = this.battleMode;
    const { units, grid, elapsedTime } = sm.getBattlefield();

    for (const controller of this.controllers) controller.tick(elapsedTime);
    if (battleMode) updateRuleHeroes(sm, this.commands, this.patrol);
    this.commands.applyAll();
    // D48: a hero with enemies near stands behind its soldiers (battle mode)
    if (battleMode)
      for (const hero of sm.getHeroes())
        updateHeroStand(sm, hero, runningCommand(hero), elapsedTime);

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
    if (battleMode) this.checkMatchEnd();
    // Classic berserker waves (ClassicWaves.ts); the stress test has none
    // Classic waves only: battle mode spawns no berserkers (D19)
    if (!this.stressMode && !battleMode) updateWaves(sm, sm.getBattlefield(), this.waveMultiplier);
  }

  // Ends the match when one side has no units left or on its objective or time limit (D30),
  // then freezes the simulation.
  private checkMatchEnd(): void {
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
      const end = objectiveEnd(this.stateManager);
      if (!end) return;
      ({ winner, reason } = end);
    }

    this.result = {
      winner,
      time: bf.elapsedTime,
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
    // A frame's timestamp is when the frame began, which can be just before start() ran
    const rawDelta = Math.max(0, (timestamp - this.lastTime) / 1000);
    this.lastTime = timestamp;

    const deltaTime = Math.min(rawDelta, 0.1) * this.speedMultiplier;

    if (!this.paused && !this.isWaitingForAI()) {
      try {
        this.update(deltaTime);
        this.stateManager.getBattlefield().elapsedTime += deltaTime;
      } catch (err) {
        this.fail(err);
      }
      if (!this.error) this.onStep?.();
    }

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

    this.rafId = requestAnimationFrame(this.loop.bind(this));
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
