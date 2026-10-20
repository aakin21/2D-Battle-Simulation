import { ATTACK_INTERVAL } from '../engine/Rules';
import {
  BehaviorState,
  ControlPoint,
  Faction,
  HeroCommand,
  IBattlefield,
  IHero,
  IUnit,
} from '../types/types';
import { clock } from '../ui/format';
import { icon } from '../ui/icons';
import { POS_SCALE, Replay, ReplayFrame } from './Replay';

// Plays a Replay: builds the battlefield for the replay's current time (positions between two
// frames are interpolated) for the renderer and the minimap, puts the side panels back as they
// were at that time, and drives the replay bar (play, pause, speed, seek, exit).

export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8] as const;

type ReplayUnitObject = IHero; // soldiers use the unit part only

export class ReplayPlayer {
  private time = 0;
  private playing = true;
  private speed: number = 1;
  private lastNow = performance.now();
  private cursor = 0; // index of the frame at or before `time`
  private objects: ReplayUnitObject[];
  private shown: IUnit[] = [];
  private bf: IBattlefield;
  private next: (Int32Array | undefined)[] = []; // per frame: each unit's place in the next frame
  private lookup: Int32Array;
  private panelsByKey = new Map<string, { t: number; html: string }[]>();
  private panelShown = new Map<string, string>();
  private open = new Set<string>(); // long texts opened in the replay's AI panels
  private commands = new Map<number, { time: number; command: HeroCommand | null }>();
  private bar: HTMLElement;
  private elPlay!: HTMLButtonElement;
  private elSeek!: HTMLInputElement;
  private elTime!: HTMLElement;
  private elSpeed!: HTMLElement;
  private onSeekReset: () => void;
  private seeking = false;
  readonly duration: number;

  constructor(
    private readonly replay: Replay,
    callbacks: { exit: () => void; seekReset: () => void }
  ) {
    const h = replay.header;
    this.duration = replay.frames.length ? replay.frames[replay.frames.length - 1].t : 0;
    this.onSeekReset = callbacks.seekReset;
    this.lookup = new Int32Array(h.units.length).fill(-1);
    this.objects = h.units.map((u) => ({
      id: u.id,
      position: { x: 0, y: 0 },
      hp: u.maxHp,
      maxHp: u.maxHp,
      courage: 0,
      unitType: u.type,
      faction: u.faction,
      state: BehaviorState.IDLE,
      sight: u.sight,
      baseSpeed: 0,
      damage: 0,
      path: [],
      target: null,
      attackCooldown: 0,
      groupId: '',
      taskPoint: null,
      charismaRadius: u.charismaRadius ?? 0,
      charismaBonus: 0,
      controller: 'ai',
      heroIndex: u.heroIndex ?? 0,
      home: { x: 0, y: 0 },
      command: null,
      commandSource: null,
      commandTime: 0,
      lastLlmCommand: null,
      lastLlmTime: 0,
      disengaging: false,
      reflexOverridden: false,
      reflexOverriddenAt: 0,
      standPoint: null,
      standUntil: 0,
      attackTargetId: null,
    }));
    const o = h.objective;
    this.bf = {
      grid: replay.grid,
      units: this.shown,
      elapsedTime: 0,
      objective: {
        mode: o.mode ?? 'elimination',
        timeLimit: o.timeLimit,
        points: o.points.map(
          (p): ControlPoint => ({ ...p, holder: null, leader: null, leaderSince: 0 })
        ),
        scores: { friendly: 0, enemy: 0 },
        bases: o.bases.map((b) => ({ ...b, hp: b.maxHp })),
      },
      waveNumber: 0,
      nextWaveTime: Infinity,
      stats: { totalSpawned: 0, casualties: 0 },
    };
    for (const p of h.panels) {
      const list = this.panelsByKey.get(p.key) ?? [];
      list.push({ t: p.t, html: p.html });
      this.panelsByKey.set(p.key, list);
    }
    this.bar = this.buildBar(callbacks.exit);
  }

  // --- Controls ---

  // The units shown now (the canvas selection and tooltip read them)
  units(): IUnit[] {
    return this.shown;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  togglePlay(): void {
    if (!this.playing && this.time >= this.duration) this.seek(0);
    this.playing = !this.playing;
    this.lastNow = performance.now();
    this.updateBar();
  }

  pause(): void {
    this.playing = false;
    this.updateBar();
  }

  changeSpeed(step: 1 | -1): void {
    const i = REPLAY_SPEEDS.indexOf(this.speed as (typeof REPLAY_SPEEDS)[number]);
    const j = Math.max(0, Math.min(REPLAY_SPEEDS.length - 1, (i < 0 ? 1 : i) + step));
    this.speed = REPLAY_SPEEDS[j];
    this.updateBar();
  }

  getSpeed(): number {
    return this.speed;
  }

  seek(t: number): void {
    const target = Math.max(0, Math.min(this.duration, t));
    // Going back: effects and order markers keep per-unit history, so they start over
    if (target < this.time) this.onSeekReset();
    this.time = target;
    this.cursor = this.frameAt(target);
    this.updateBar();
  }

  dispose(): void {
    this.bar.remove();
  }

  // --- Each frame ---

  // The battlefield at the replay's time, advanced by the real time since the last call
  battlefield(): IBattlefield {
    const now = performance.now();
    if (this.playing && !this.seeking) {
      this.time += (Math.min(0.1, (now - this.lastNow) / 1000) || 0) * this.speed;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.playing = false;
      }
    }
    this.lastNow = now;
    const frames = this.replay.frames;
    if (frames.length === 0) return this.bf;
    while (this.cursor + 1 < frames.length && frames[this.cursor + 1].t <= this.time) this.cursor++;
    const a = frames[this.cursor];
    const b = frames[this.cursor + 1];
    const f = b && b.t > a.t ? Math.max(0, Math.min(1, (this.time - a.t) / (b.t - a.t))) : 0;
    const next = b ? this.nextOf(this.cursor) : undefined;

    this.shown.length = 0;
    for (let k = 0; k < a.idx.length; k++) {
      const u = this.objects[a.idx[k]];
      let x = a.x[k];
      let y = a.y[k];
      const kb = next ? next[k] : -1;
      if (b && kb >= 0) {
        x += (b.x[kb] - x) * f;
        y += (b.y[kb] - y) * f;
      }
      u.position.x = x / POS_SCALE;
      u.position.y = y / POS_SCALE;
      u.hp = a.hp[k];
      u.state = a.state[k] as BehaviorState;
      u.courage = a.courage[k];
      // The attack pose comes from the cooldown: let it cycle while the unit fights
      u.attackCooldown =
        u.state === BehaviorState.ATTACK
          ? ATTACK_INTERVAL - ((this.time + (a.idx[k] % 17) / 17) % ATTACK_INTERVAL)
          : 0;
      this.shown.push(u);
    }
    for (const h of a.heroes) {
      const hero = this.objects[h.i];
      hero.taskPoint = h.taskPoint;
      // The same command object while the order is unchanged (the marker rings on a new one)
      const seen = this.commands.get(h.i);
      if (!seen || seen.time !== h.commandTime) {
        this.commands.set(h.i, { time: h.commandTime, command: h.command });
      }
      hero.command = this.commands.get(h.i)!.command;
      hero.commandTime = h.commandTime;
    }
    const o = this.bf.objective;
    a.objective.holders.forEach((holder, i) => {
      if (o.points[i]) o.points[i].holder = holder as Faction | null;
    });
    o.scores.friendly = a.objective.scores.friendly;
    o.scores.enemy = a.objective.scores.enemy;
    a.objective.baseHp.forEach((hp, i) => {
      if (o.bases[i]) o.bases[i].hp = hp;
    });
    this.bf.elapsedTime = this.time;
    return this.bf;
  }

  // Puts the side panels back as they were at the replay's time (the UI's refresh calls it)
  applyPanels(): void {
    for (const [key, list] of this.panelsByKey) {
      let lo = 0;
      let hi = list.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].t <= this.time) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      const html = found >= 0 ? list[found].html : '';
      if (this.panelShown.get(key) === html) continue;
      this.panelShown.set(key, html);
      this.showPanel(key, html);
    }
    this.updateBar();
  }

  private showPanel(key: string, html: string): void {
    if (key === 'layout') {
      let layout = { west: false, east: false, two: false };
      try {
        layout = { ...layout, ...JSON.parse(html || '{}') };
      } catch {
        // keep the default
      }
      document.getElementById('ai-col-west')!.hidden = !layout.west;
      document.getElementById('ai-col-east')!.hidden = !layout.east;
      document.getElementById('side-panel')!.classList.toggle('ai-two', layout.two);
      return;
    }
    const selector: Record<string, string> = {
      banner: '#match-banner',
      armies: '#armies-body',
      armiesTitle: '#armies-title',
      west: '#ai-col-west .ai-col-main',
      east: '#ai-col-east .ai-col-main',
    };
    const el = document.querySelector<HTMLElement>(selector[key] ?? '');
    if (!el) return;
    el.innerHTML = html;
    // Long LLM texts the viewer opened in the replay stay open
    el.querySelectorAll<HTMLElement>('[data-toggle]').forEach((t) => {
      if (this.open.has(t.dataset.toggle!)) this.setOpen(t, true);
    });
  }

  // "more" / "less" in a replayed AI panel (the live panel's own handler is not running)
  toggleText(target: HTMLElement): boolean {
    const t = target.closest<HTMLElement>('[data-toggle]');
    if (!t) return false;
    const key = t.dataset.toggle!;
    const open = !this.open.has(key);
    if (open) this.open.add(key);
    else this.open.delete(key);
    this.setOpen(t, open);
    return true;
  }

  private setOpen(toggle: HTMLElement, open: boolean): void {
    toggle.previousElementSibling?.classList.toggle('ai-clamp', !open);
    toggle.textContent = open ? '▾ less' : '▸ more';
  }

  // --- Frames ---

  private frameAt(t: number): number {
    const frames = this.replay.frames;
    let lo = 0;
    let hi = frames.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  // Where each unit of frame i is in frame i + 1 (-1: it died), worked out once per frame
  private nextOf(i: number): Int32Array {
    const cached = this.next[i];
    if (cached) return cached;
    const a: ReplayFrame = this.replay.frames[i];
    const b: ReplayFrame = this.replay.frames[i + 1];
    for (let k = 0; k < b.idx.length; k++) this.lookup[b.idx[k]] = k;
    const out = new Int32Array(a.idx.length);
    for (let k = 0; k < a.idx.length; k++) out[k] = this.lookup[a.idx[k]];
    for (let k = 0; k < b.idx.length; k++) this.lookup[b.idx[k]] = -1;
    this.next[i] = out;
    return out;
  }

  // --- The replay bar ---

  private buildBar(exit: () => void): HTMLElement {
    const bar = document.createElement('div');
    bar.id = 'replay-bar';
    bar.className = 'panel-sm';
    bar.innerHTML =
      `<span class="replay-tag">Replay</span>` +
      `<button class="icon-btn" data-act="play" title="Play / pause (Space)"></button>` +
      `<button class="btn btn-small" data-act="slower" title="Slower (−)">−</button>` +
      `<span class="speed well" data-el="speed"></span>` +
      `<button class="btn btn-small" data-act="faster" title="Faster (+)">+</button>` +
      `<input type="range" min="0" max="${Math.max(1, Math.ceil(this.duration * 10))}" step="1" value="0" data-el="seek" aria-label="Time in the match">` +
      `<span class="replay-time" data-el="time"></span>` +
      `<button class="btn btn-small" data-act="exit" title="Leave the replay (Esc opens the menu)">Exit</button>`;
    this.elPlay = bar.querySelector('[data-act="play"]')!;
    this.elSeek = bar.querySelector('[data-el="seek"]')!;
    this.elTime = bar.querySelector('[data-el="time"]')!;
    this.elSpeed = bar.querySelector('[data-el="speed"]')!;
    bar.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'play') this.togglePlay();
      else if (act === 'slower') this.changeSpeed(-1);
      else if (act === 'faster') this.changeSpeed(1);
      else if (act === 'exit') exit();
    });
    this.elSeek.addEventListener('input', () => {
      this.seeking = true;
      this.seek(Number(this.elSeek.value) / 10);
    });
    this.elSeek.addEventListener('change', () => {
      this.seeking = false;
      this.lastNow = performance.now();
    });
    document.getElementById('canvas-area')!.appendChild(bar);
    this.updateBar();
    return bar;
  }

  private shownPlaying: boolean | null = null;

  private updateBar(): void {
    if (!this.elPlay) return;
    if (this.shownPlaying !== this.playing) {
      this.shownPlaying = this.playing;
      this.elPlay.innerHTML = icon(this.playing ? 'pause' : 'play');
      this.elPlay.title = this.playing ? 'Pause (Space)' : 'Play (Space)';
    }
    this.elSpeed.textContent = `${this.speed}x`;
    if (!this.seeking) this.elSeek.value = String(Math.round(this.time * 10));
    this.elTime.textContent = `${clock(this.time)} / ${clock(this.duration)}`;
  }
}
