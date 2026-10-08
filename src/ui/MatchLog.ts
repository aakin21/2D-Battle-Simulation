import { StateManager } from '../state/StateManager';
import type { MatchResult } from '../engine/SimulationEngine';
import type { JevController } from '../ai/JevController';
import type { LlmController } from '../ai/LlmController';
import { BehaviorState, Faction, SimConfig, UnitType } from '../types/types';

// Everything needed to study a battle afterwards (Q11): the settings, the result, a timeline
// of both armies once per simulation second, and every AI decision with its response time.
// Downloaded as JSON from the AI panel or the match result. Reads the battlefield only.

export interface AiSide {
  jev?: JevController;
  llm?: LlmController;
}

export type AiSides = Record<'west' | 'east', AiSide>;

interface SideSample {
  soldiers: number;
  heroes: number;
  hp: number;
  fleeing: number;
  points?: number;
  baseHpPercent?: number;
}

interface Sample {
  t: number; // simulation seconds
  west: SideSample;
  east: SideSample;
}

const SAMPLE_EVERY = 1; // simulation seconds between timeline samples

export class MatchLog {
  private samples: Sample[] = [];
  private nextSample = 0;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private config: SimConfig,
    private map: string,
    private sides: AiSides
  ) {}

  // Called often by the UI; takes at most one sample per simulation second.
  sample(sm: StateManager): void {
    const t = sm.getBattlefield().elapsedTime;
    if (t < this.nextSample) return;
    this.nextSample = (Math.floor(t / SAMPLE_EVERY) + 1) * SAMPLE_EVERY;
    this.samples.push(this.measure(sm));
  }

  private measure(sm: StateManager): Sample {
    const bf = sm.getBattlefield();
    const side = (): SideSample => ({ soldiers: 0, heroes: 0, hp: 0, fleeing: 0 });
    const s = [side(), side()];
    for (const u of bf.units) {
      if (u.hp <= 0) continue;
      const x = s[u.faction];
      x.hp += u.hp;
      if (u.unitType === UnitType.HERO) x.heroes++;
      else x.soldiers++;
      if (u.state === BehaviorState.FLEE) x.fleeing++;
    }
    const o = bf.objective;
    if (o.mode === 'control') {
      s[Faction.FRIENDLY].points = Math.floor(o.scores.friendly);
      s[Faction.ENEMY].points = Math.floor(o.scores.enemy);
    }
    for (const b of o.bases) s[b.faction].baseHpPercent = Math.round((100 * b.hp) / b.maxHp);
    for (const x of s) x.hp = Math.round(x.hp);
    return { t: Math.round(bf.elapsedTime * 10) / 10, west: s[0], east: s[1] };
  }

  private settings(): Record<string, unknown> {
    const c = this.config;
    const usesLlm = (ai?: string) => ai?.includes('llm') ?? false;
    return {
      mode: c.mode,
      objective: c.objective ?? 'elimination',
      map: this.map,
      soldiersPerSide: c.warriorCount,
      heroesPerSide: c.heroesPerSide,
      terrain: c.terrainDensity,
      west: c.friendlyAI ?? 'none',
      east: c.enemyAI ?? 'none',
      westModel: usesLlm(c.friendlyAI) ? c.friendlyModel : undefined,
      eastModel: usesLlm(c.enemyAI) ? c.enemyModel : undefined,
      aiTiming: c.aiTiming ?? 'realtime',
    };
  }

  private ai(side: AiSide): Record<string, unknown> | null {
    if (!side.jev && !side.llm) return null;
    return {
      llm: side.llm
        ? {
            decisions: side.llm.decisions,
            skippedRequests: side.llm.skippedRequests,
            failure: side.llm.failure,
            rulebook: side.llm.system,
          }
        : undefined,
      jev: side.jev
        ? {
            decisions: side.jev.decisions,
            skippedRequests: side.jev.skippedRequests,
            failure: side.jev.failure,
          }
        : undefined,
    };
  }

  // error: the run was stopped by an exception in the simulation (SimulationEngine.fail)
  build(
    sm: StateManager,
    result: MatchResult | null,
    error: string | null = null
  ): Record<string, unknown> {
    const now = this.measure(sm);
    const timeline =
      this.samples.length && this.samples[this.samples.length - 1].t === now.t
        ? this.samples
        : [...this.samples, now];
    return {
      app: '2D Battle Simulation',
      version: __APP_VERSION__,
      startedAt: this.startedAt,
      savedAt: new Date().toISOString(),
      settings: this.settings(),
      result: result
        ? {
            winner:
              result.winner === null
                ? 'draw'
                : result.winner === Faction.FRIENDLY
                  ? 'west'
                  : 'east',
            reason: result.reason,
            time: Math.round(result.time * 10) / 10,
            unitsLeftOnWinningSide: result.survivors,
            points: result.scores,
          }
        : error
          ? { stoppedByError: error }
          : 'not finished',
      timeline,
      ai: { west: this.ai(this.sides.west), east: this.ai(this.sides.east) },
    };
  }

  download(sm: StateManager, result: MatchResult | null, error: string | null = null): void {
    const c = this.config;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const name = `match-${c.objective ?? 'elimination'}-${c.friendlyAI ?? 'none'}-vs-${c.enemyAI ?? 'none'}-${stamp}.json`;
    const blob = new Blob([JSON.stringify(this.build(sm, result, error), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/\+/g, '');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
