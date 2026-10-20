import { IBattlefield } from '../types/types';
import type { EffectsManager } from './effects/EffectsManager';

// The debug box in the main view's corner: FPS, unit count, time and, with FX on, the effect
// counters (hits and deaths since the last reset, corpses and blood pools shown).
export class DebugOverlay {
  private fps: number = 0;
  private fpsFrameCount: number = 0;
  private fpsLastTime: number = 0;
  // Cumulative event counts since the last reset
  private hitCount: number = 0;
  private deathCount: number = 0;

  // Once per frame, drawn or not
  tick(): void {
    this.fpsFrameCount++;
    const now = performance.now();
    if (this.fpsLastTime === 0) {
      this.fpsLastTime = now;
      return;
    }
    if (now - this.fpsLastTime >= 1000) {
      this.fps = Math.round((this.fpsFrameCount * 1000) / (now - this.fpsLastTime));
      this.fpsFrameCount = 0;
      this.fpsLastTime = now;
    }
  }

  // This frame's hits and deaths found by the effects
  countEvents(hits: number, deaths: number): void {
    this.hitCount += hits;
    this.deathCount += deaths;
  }

  resetCounts(): void {
    this.hitCount = 0;
    this.deathCount = 0;
  }

  draw(ctx: CanvasRenderingContext2D, battlefield: IBattlefield, effects: EffectsManager): void {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(4, 4, 190, 96);
    ctx.fillStyle = '#00ff88';
    ctx.font = '11px monospace';
    ctx.fillText(`FPS: ${this.fps}`, 10, 19);
    ctx.fillText(`Units: ${battlefield.units.length}`, 10, 33);
    ctx.fillText(`T: ${Math.floor(battlefield.elapsedTime)}s`, 10, 47);
    if (effects.isEnabled()) {
      ctx.fillText(`FX hits: ${this.hitCount}`, 10, 61);
      ctx.fillText(`FX deaths: ${this.deathCount}`, 10, 75);
      ctx.fillText(
        `corpses ${effects.getCorpseCount()} pools ${effects.getBloodPoolCount()}`,
        10,
        89
      );
    } else {
      ctx.fillText('FX: off', 10, 61);
    }
  }
}
