import type { MatchResult } from '../engine/SimulationEngine';
import { IBattlefield, IHero, SimConfig, UnitType } from '../types/types';
import {
  encodeReplay,
  PanelSnapshot,
  POS_SCALE,
  Replay,
  ReplayFrame,
  ReplayUnit,
  REPLAY_FORMAT,
  REPLAY_VERSION,
} from './Replay';

// Records a battle-mode match for ReplayPlayer. It only reads the battlefield and the page:
// frames are taken a few times per simulated second (engine frame observer), the side panels
// whenever their HTML changes (the UI's 100 ms refresh).

const FRAMES_PER_SECOND = 3;
// The page elements whose HTML is kept, by key
const PANELS: Record<string, string> = {
  banner: '#match-banner',
  armies: '#armies-body',
  armiesTitle: '#armies-title',
  west: '#ai-col-west .ai-col-main',
  east: '#ai-col-east .ai-col-main',
};

export class ReplayRecorder {
  private units: ReplayUnit[] = [];
  private unitIndex = new Map<string, number>();
  private frames: ReplayFrame[] = [];
  private panels: PanelSnapshot[] = [];
  private lastPanel = new Map<string, string>();
  private nextAt = 0;
  private result: MatchResult | null = null;
  private readonly started = new Date().toISOString();

  constructor(
    private readonly config: SimConfig,
    private readonly mapChoice: string,
    private readonly bf: IBattlefield
  ) {}

  get frameCount(): number {
    return this.frames.length;
  }

  get finished(): boolean {
    return this.result !== null;
  }

  // Called after every simulation step; keeps a frame every 1/FRAMES_PER_SECOND s
  sample(): void {
    if (this.result || this.bf.elapsedTime < this.nextAt) return;
    // On a fixed schedule (steps do not land exactly on it); after a long gap, from now
    this.nextAt = Math.max(this.nextAt + 1 / FRAMES_PER_SECOND, this.bf.elapsedTime);
    this.frames.push(this.frame());
  }

  // Called by the UI after the panels were drawn
  samplePanels(): void {
    if (this.result) return;
    const t = this.bf.elapsedTime;
    for (const [key, selector] of Object.entries(PANELS)) {
      const el = document.querySelector(selector);
      this.keep(t, key, el ? el.innerHTML : '');
    }
    const side = document.getElementById('side-panel');
    this.keep(
      t,
      'layout',
      JSON.stringify({
        west: !document.getElementById('ai-col-west')?.hidden,
        east: !document.getElementById('ai-col-east')?.hidden,
        two: side?.classList.contains('ai-two') ?? false,
      })
    );
  }

  // The match is over: a last frame and panels, then nothing more is recorded
  finish(result: MatchResult): void {
    if (this.result) return;
    this.frames.push(this.frame());
    this.samplePanels();
    this.result = result;
  }

  replay(): Replay {
    const o = this.bf.objective;
    const config = { ...this.config };
    delete config.presetGrid; // the map is kept once, as `grid`
    return {
      grid: this.bf.grid,
      frames: this.frames,
      header: {
        format: REPLAY_FORMAT,
        version: REPLAY_VERSION,
        app: __APP_VERSION__,
        savedAt: this.started,
        config,
        mapChoice: this.mapChoice,
        grid: '',
        objective: {
          mode: o.mode,
          timeLimit: o.timeLimit,
          points: o.points.map((p) => ({ name: p.name, position: { ...p.position } })),
          bases: o.bases.map((b) => ({
            faction: b.faction,
            position: { ...b.position },
            maxHp: b.maxHp,
          })),
        },
        units: this.units,
        panels: this.panels,
        result: this.result,
        frameCount: this.frames.length,
      },
    };
  }

  async download(): Promise<void> {
    const blob = await encodeReplay(this.replay());
    const c = this.config;
    const stamp = this.started.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const name = `match-${c.objective ?? 'elimination'}-${c.friendlyAI ?? 'none'}-vs-${c.enemyAI ?? 'none'}-${stamp}.replay`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/\+/g, '');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private keep(t: number, key: string, html: string): void {
    if (this.lastPanel.get(key) === html) return;
    this.lastPanel.set(key, html);
    this.panels.push({ t, key, html });
  }

  private frame(): ReplayFrame {
    const bf = this.bf;
    const living = bf.units.filter((u) => u.hp > 0);
    const n = living.length;
    const f: ReplayFrame = {
      t: bf.elapsedTime,
      idx: new Uint16Array(n),
      x: new Int16Array(n),
      y: new Int16Array(n),
      hp: new Uint16Array(n),
      state: new Uint8Array(n),
      courage: new Uint8Array(n),
      heroes: [],
      objective: {
        holders: bf.objective.points.map((p) => p.holder),
        scores: { ...bf.objective.scores },
        baseHp: bf.objective.bases.map((b) => b.hp),
      },
    };
    living.forEach((u, k) => {
      let i = this.unitIndex.get(u.id);
      if (i === undefined) {
        i = this.units.length;
        this.unitIndex.set(u.id, i);
        const hero = u.unitType === UnitType.HERO ? (u as IHero) : null;
        this.units.push({
          id: u.id,
          type: u.unitType,
          faction: u.faction,
          maxHp: u.maxHp,
          sight: u.sight,
          ...(hero ? { heroIndex: hero.heroIndex, charismaRadius: hero.charismaRadius } : {}),
        });
      }
      f.idx[k] = i;
      f.x[k] = Math.round(u.position.x * POS_SCALE);
      f.y[k] = Math.round(u.position.y * POS_SCALE);
      f.hp[k] = Math.max(0, Math.round(u.hp));
      f.state[k] = u.state;
      f.courage[k] = Math.max(0, Math.min(255, Math.round(u.courage)));
      if (u.unitType === UnitType.HERO) {
        const h = u as IHero;
        f.heroes.push({
          i,
          taskPoint: h.taskPoint ? { ...h.taskPoint } : null,
          command: h.command,
          commandTime: h.commandTime,
        });
      }
    });
    return f;
  }
}
