import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';

export class SimulationEngine {
  private stateManager: StateManager;
  private renderer: Renderer;
  private minimapRenderer: MinimapRenderer;

  private paused: boolean = false;
  private speedMultiplier: number = 1;
  private lastTime: number = 0;
  private rafId: number = 0;

  constructor(
    stateManager: StateManager,
    renderer: Renderer,
    minimapRenderer: MinimapRenderer
  ) {
    this.stateManager = stateManager;
    this.renderer = renderer;
    this.minimapRenderer = minimapRenderer;
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

  resume(): void {
    this.paused = false;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setSpeed(multiplier: 0.5 | 1 | 2 | 4): void {
    this.speedMultiplier = multiplier;
  }

  getSpeed(): number {
    return this.speedMultiplier;
  }

  // Cycle through speed values: 0.5 → 1 → 2 → 4 → 0.5
  increaseSpeed(): void {
    const steps: Array<0.5 | 1 | 2 | 4> = [0.5, 1, 2, 4];
    const idx = steps.indexOf(this.speedMultiplier as 0.5 | 1 | 2 | 4);
    if (idx < steps.length - 1) this.speedMultiplier = steps[idx + 1];
  }

  decreaseSpeed(): void {
    const steps: Array<0.5 | 1 | 2 | 4> = [0.5, 1, 2, 4];
    const idx = steps.indexOf(this.speedMultiplier as 0.5 | 1 | 2 | 4);
    if (idx > 0) this.speedMultiplier = steps[idx - 1];
  }

  restart(): void {
    this.stop();
    this.stateManager.reset();
    this.paused = false;
    this.speedMultiplier = 1;
    this.start();
  }

  // Simulation logic will be added in later weeks
  private update(_deltaTime: number): void {
    // Week 2+: movement, pathfinding
    // Week 3+: combat
    // Week 4+: courage calculation
    // Week 5+: flee and rest behavior
    // Week 6+: hero control and charisma
    // Week 7+: wave spawning
  }

  private loop(timestamp: number): void {
    const rawDelta = (timestamp - this.lastTime) / 1000;
    this.lastTime = timestamp;

    // Cap delta to avoid large jumps when tab was inactive
    const deltaTime = Math.min(rawDelta, 0.1) * this.speedMultiplier;

    if (!this.paused) {
      this.update(deltaTime);
      this.stateManager.getBattlefield().elapsedTime += deltaTime;
    }

    const battlefield = this.stateManager.getBattlefield();
    this.renderer.render(battlefield);
    this.minimapRenderer.render(battlefield, this.renderer.getCamera());

    this.rafId = requestAnimationFrame(this.loop.bind(this));
  }
}
