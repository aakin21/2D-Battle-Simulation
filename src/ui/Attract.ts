import { Renderer } from '../rendering/Renderer';
import { reducedMotion } from '../rendering/ReducedMotion';
import { decodeReplay } from '../replay/Replay';
import { ReplayPlayer } from '../replay/ReplayPlayer';
import { decodeGrid } from '../state/MapStore';
import { FIXED_MAP } from '../maps/fixedMap';
import { GRID_SIZE, IBattlefield, TerrainType } from '../types/types';

// The battle behind the front end: a recorded battle of rule heroes on both sides
// (`public/attract/battle.replay`, made headless by `../tests/smoke/attract-record.ts`) played in a
// loop on its own canvas by a ReplayPlayer and a Renderer of its own. Nothing is simulated: no
// StateManager and no SimulationEngine, and the page's random numbers are never drawn: the player
// reads the file's frames, the renderer's effects draw from their own generator (fxRandom). So the
// page's simulation and its random sequence are never touched. No sound, no hints, no replay bar. The file is fetched after the
// title screen is shown and never holds the menu up; while it loads, or when it cannot be loaded
// or read, a still battlefield (the fixed map's ground) stays. FrontEnd makes one when the front
// end opens and disposes of it when the front end closes (before a run starts or a replay is
// shown). 30 frames a second, paused while the tab is hidden; with prefers-reduced-motion one
// still frame of the battle. The loop's restart fades through the menu's shade.

export const ATTRACT_URL = 'attract/battle.replay'; // relative to the page (any base path)
const FRAME_MS = 1000 / 30; // a backdrop: 30 frames a second are enough
const MAX_STEP_S = 0.1; // the most battle time one frame moves on (a slow or late frame)
const FADE_S = 0.8; // the loop's end fades to the shade, its start fades in from it
const SHADE = 'rgb(14, 12, 9)'; // the menu's shade (menu-fx.css)
const STILL_AT_S = 0; // reduced motion: the battle's moment shown
const FOLLOW_MS = 2000; // the camera glides to the units this often
const MIN_ZOOM = 11; // pixels per tile, at least
const LOAD_TIMEOUT_MS = 30_000;
// Re-drawn a few times while the art loads (a still battlefield)
const STILL_DRAWS_MS = [0, 250, 800, 2000, 4000];

// running: playing; paused: the tab is hidden; still: reduced motion, or the recording not (yet)
// there; off: disposed
export type AttractState = 'running' | 'paused' | 'still' | 'off';

export class AttractBattle {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer | null;
  player: ReplayPlayer | null = null;
  // The recording: being fetched, playing (or still), or not there (missing, damaged, offline)
  source: 'loading' | 'ready' | 'failed' = 'loading';
  private abort: AbortController | null = new AbortController();
  private raf = 0;
  private lastFrame = 0;
  private lastNow: number | null = null;
  private lastFollow = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private resize: ResizeObserver | null = null;
  private onVisibility = () => this.visibilityChanged();
  readonly still = reducedMotion();
  running = false; // the frame loop is on (not hidden, not still, not disposed)
  time = 0; // seconds into the recording
  fade = 1; // the shade over the battle (1: all shade)
  frames = 0; // frames played (for tests)
  loops = 0; // times the recording started over (for tests)

  // `onState`: told whenever the battle starts, pauses or ends (FrontEnd shows it as data-attract)
  constructor(
    canvas: HTMLCanvasElement,
    private onState: (state: AttractState) => void = () => {},
    url = ATTRACT_URL
  ) {
    this.canvas = canvas;
    this.renderer = new Renderer(canvas.id);
    this.fit();
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(() => {
        this.fit();
        if (!this.running) this.drawStill();
      });
      this.resize.observe(canvas);
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    this.stillDraws();
    this.onState('still');
    // After the title screen is shown: its first frame comes first (a hidden tab loads when shown)
    requestAnimationFrame(() => this.later(() => void this.load(url), 0));
  }

  // Ends it for good: no frame, timer, listener or request is left, the canvas is cleared and the
  // player and renderer are let go
  dispose(): void {
    this.stop();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.resize?.disconnect();
    this.resize = null;
    this.abort?.abort();
    this.abort = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.player?.dispose();
    this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.player = null;
    this.renderer = null;
    this.onState('off');
  }

  get disposed(): boolean {
    return this.renderer === null;
  }

  // One frame at `now` (the loop's; tests call it too): the recording moves on by the time since
  // the last frame (at most MAX_STEP_S), starting over after its end, and is drawn
  frame(now: number): void {
    const player = this.player;
    if (!player || !this.renderer) return;
    this.frames++;
    const dt =
      this.lastNow === null ? 0 : Math.min(MAX_STEP_S, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.time += dt;
    if (this.time >= player.duration) {
      // Under the shade: from the start again (seeking back clears the effects' history)
      this.time = 0;
      this.loops++;
      this.draw(0);
      this.follow(false);
      this.lastFollow = now;
      return;
    }
    this.draw(this.time);
    if (now - this.lastFollow >= FOLLOW_MS) {
      this.lastFollow = now;
      this.follow(true);
    }
  }

  // --- The recording ---

  private async load(url: string): Promise<void> {
    const abort = this.abort;
    if (!abort) return;
    const timer = setTimeout(() => abort.abort(), LOAD_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const replay = await decodeReplay(await res.blob());
      if (this.disposed) return;
      if (replay.frames.length < 2) throw new Error('no frames');
      const renderer = this.renderer!;
      this.player = new ReplayPlayer(replay, { seekReset: () => renderer.resetHistory() });
      this.player.pause(); // its time is set here, frame by frame
      this.source = 'ready';
      renderer.setBattleMode(true);
      renderer.clearTerrainCache(); // another map than the still one
      this.fit();
      this.time = 0;
      this.draw(this.still ? Math.min(STILL_AT_S, this.player.duration) : 0);
      this.follow(false);
      if (this.still) this.stillDraws();
      else if (document.hidden) this.onState('paused');
      else this.play();
    } catch (err) {
      if (this.disposed) return;
      this.source = 'failed';
      this.player = null;
      console.warn('No attract battle:', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  // The recording at `t` with the shade the loop's fades put over it
  private draw(t: number): void {
    const player = this.player;
    const r = this.renderer;
    if (!player || !r) return;
    player.seek(t);
    r.render(player.battlefield());
    this.fade = this.still ? 0 : Math.max(0, 1 - t / FADE_S, 1 - (player.duration - t) / FADE_S);
    if (this.fade > 0) {
      const ctx = this.canvas.getContext('2d')!;
      ctx.globalAlpha = Math.min(1, this.fade);
      ctx.fillStyle = SHADE;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalAlpha = 1;
    }
  }

  // Reduced motion, or the recording not there: the battle's still moment, or the fixed map's
  // ground with nobody on it
  private drawStill(): void {
    const r = this.renderer;
    if (!r || this.running) return;
    if (this.player) this.draw(this.still ? Math.min(STILL_AT_S, this.player.duration) : this.time);
    else r.render(stillField());
  }

  private stillDraws(): void {
    for (const ms of STILL_DRAWS_MS) this.later(() => this.drawStill(), ms);
  }

  // The camera covers the window and keeps to where the units are
  private follow(smooth: boolean): void {
    const units = this.player?.units() ?? [];
    let x = GRID_SIZE / 2;
    let y = GRID_SIZE / 2;
    if (units.length) {
      x = units.reduce((s, u) => s + u.position.x, 0) / units.length;
      y = units.reduce((s, u) => s + u.position.y, 0) / units.length;
    }
    this.renderer?.centerOn(x, y, smooth);
  }

  // The canvas fills the window; zoomed in until the map covers it (no empty bands) and the
  // units are large enough to see
  private fit(): void {
    const r = this.renderer;
    if (!r) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    r.resize(w, h);
    const zoom = Math.max(Math.max(w, h) / GRID_SIZE, MIN_ZOOM);
    for (let i = 0; i < 16 && r.getCamera().zoom < zoom * 0.999; i++) r.zoomAt(1, w / 2, h / 2);
  }

  // --- The loop ---

  private play(): void {
    if (this.running || this.still || !this.player || this.disposed || document.hidden) return;
    this.running = true;
    this.lastNow = null; // the time away is not played
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      if (now - this.lastFrame < FRAME_MS - 1) return;
      this.lastFrame = now;
      this.frame(now);
    };
    this.raf = requestAnimationFrame(loop);
    this.onState('running');
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;
  }

  // Paused while the tab is hidden
  private visibilityChanged(): void {
    if (this.still || !this.player || this.disposed) return;
    if (document.hidden) {
      this.stop();
      this.onState('paused');
    } else this.play();
  }

  private later(fn: () => void, ms: number): void {
    if (this.disposed) return;
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      fn();
    }, ms);
    this.timers.push(t);
  }
}

// The fixed map's ground with nobody on it (made once)
let still: IBattlefield | null = null;
function stillField(): IBattlefield {
  still ??= {
    grid: decodeGrid(FIXED_MAP) as TerrainType[][],
    units: [],
    elapsedTime: 0,
    objective: {
      mode: 'elimination',
      points: [],
      scores: { friendly: 0, enemy: 0 },
      timeLimit: null,
      bases: [],
    },
    waveNumber: 0,
    nextWaveTime: Infinity,
    stats: { totalSpawned: 0, casualties: 0 },
  };
  return still;
}
