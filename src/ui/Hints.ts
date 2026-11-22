import type { StateManager } from '../state/StateManager';
import type { Renderer } from '../rendering/Renderer';
import { Faction, IHero, IUnit, UnitType } from '../types/types';
import { reducedMotion } from '../rendering/ReducedMotion';
import { HintKind, hintsSeen, saveHintsSeen } from './Settings';

// Short hints in context, the first time per browser (Settings.ts), a DOM layer over the
// battlefield (nothing is drawn on the canvas). In a battle the user commands: select a hero
// (a ring marks one of theirs), then right-click to send it, then the keys; each step goes on when
// the user does it (or with "Got it"), "Skip hints" ends them. While a replay or an AI-only battle
// is watched: one hint on what can be done. Read-only: it reads the heroes and the camera, never
// changes the simulation, never takes focus and never pauses; the battlefield stays usable
// around the hint. The Controls screen can bring the hints back.

export type HintMode = 'play' | 'watch' | null;

export interface HintHost {
  // What the user is doing now: commanding a side, watching, or neither (menu, loading screen,
  // a finished match, classic modes)
  mode(): HintMode;
  replaying(): boolean;
}

const PLAY_STEPS = [
  'Click one of your heroes to select it: the units with a gold ring at their feet, like the one marked here.',
  'Now right-click a place on the map: the hero walks there and its soldiers follow.',
  'Space pauses, + and − change the speed, Esc opens the menu. Scroll to zoom; drag on the map to count the units in an area.',
];
const EXIT_MS = 150; // the hint's fade-out (hints.css)
const MARGIN = 10;

export class Hints {
  private seen: Record<HintKind, boolean> = { play: hintsSeen('play'), watch: hintsSeen('watch') };
  private step = 0; // the play hint's step (PLAY_STEPS)
  private selectedId: string | null = null;
  private shownKey: string | null = null; // which hint the layer shows: "play:1", "watch:replay"
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private fresh = false; // just shown: placed at once, not moved there

  private el: HTMLElement;
  private box: HTMLElement;
  private text: HTMLElement;
  private count: HTMLElement;
  private next: HTMLButtonElement;
  private skip: HTMLButtonElement;
  private caret: HTMLElement;
  private ring: HTMLElement;
  private area = document.getElementById('canvas-area')!;

  constructor(
    private stateManager: StateManager,
    private renderer: Renderer,
    private host: HintHost
  ) {
    const area = this.area;
    this.ring = document.createElement('div');
    this.ring.className = 'hint-ring';
    this.ring.hidden = true;
    this.el = document.createElement('div');
    this.el.className = 'hint';
    this.el.hidden = true;
    this.el.innerHTML =
      '<div class="hint-box panel-sm" role="status"><div class="hint-text"><span class="hint-count"></span><span class="hint-msg"></span></div>' +
      '<div class="hint-actions"><button class="btn btn-small hint-next">Got it</button><button class="btn btn-quiet btn-small hint-skip">Skip hints</button></div></div>' +
      '<div class="hint-caret"></div>';
    area.appendChild(this.ring);
    area.appendChild(this.el);
    const part = (cls: string) => this.el.querySelector(`.${cls}`) as HTMLElement;
    this.box = part('hint-box');
    this.text = part('hint-msg');
    this.count = part('hint-count');
    this.next = part('hint-next') as HTMLButtonElement;
    this.skip = part('hint-skip') as HTMLButtonElement;
    this.caret = part('hint-caret');
    this.next.addEventListener('click', () => this.gotIt());
    this.skip.addEventListener('click', () => this.skipAll());
  }

  // --- What the user does ---

  // A unit was selected (left click), or the selection cleared (null)
  userSelected(unit: IUnit | null): void {
    this.selectedId = unit?.id ?? null;
    if (this.shownKey === 'play:0' && unit && isOwnHero(unit)) this.step = 1;
    else if (this.shownKey?.startsWith('watch') && unit) this.done('watch');
    else return;
    this.update();
  }

  // A hero got the user's order (right click)
  userOrdered(): void {
    if (this.shownKey !== 'play:0' && this.shownKey !== 'play:1') return;
    this.step = 2;
    this.update();
  }

  keyPressed(key: string): void {
    if (this.shownKey === 'play:2' && [' ', '+', '=', '-', 'Escape'].includes(key)) {
      this.done('play');
      this.update();
    }
  }

  // The Controls screen's "Show the hints again": they start over at the next chance (now, in a
  // battle the user commands or watches)
  showAgain(): void {
    for (const kind of ['play', 'watch'] as const) {
      this.seen[kind] = false;
      saveHintsSeen(kind, false);
    }
    this.step = 0;
    this.shownKey = null;
  }

  private gotIt(): void {
    if (this.shownKey?.startsWith('play') && this.step < PLAY_STEPS.length - 1) this.step++;
    else this.done(this.shownKey?.startsWith('play') ? 'play' : 'watch');
    this.update();
  }

  private skipAll(): void {
    this.done('play');
    this.done('watch');
    this.update();
  }

  private done(kind: HintKind): void {
    this.seen[kind] = true;
    saveHintsSeen(kind, true);
  }

  // --- Showing ---

  // Every UI refresh (100 ms): the hint for what the user is doing, placed by the camera
  update(): void {
    const mode = this.host.mode();
    const kind: HintKind | null = mode && !this.seen[mode] ? mode : null;
    if (!kind) {
      this.hide();
      return;
    }
    const replay = this.host.replaying();
    const key = kind === 'play' ? `play:${this.step}` : `watch:${replay ? 'replay' : 'live'}`;
    if (key !== this.shownKey) this.show(kind, key, replay);
    this.place(kind);
  }

  private show(kind: HintKind, key: string, replay: boolean): void {
    this.shownKey = key;
    const play = kind === 'play';
    this.count.textContent = play ? `${this.step + 1}/${PLAY_STEPS.length} ` : '';
    this.text.textContent = play ? PLAY_STEPS[this.step] : watchText(replay);
    this.next.textContent = play && this.step === PLAY_STEPS.length - 1 ? 'Done' : 'Got it';
    this.skip.hidden = !play || this.step === PLAY_STEPS.length - 1;
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.fresh = this.el.hidden || this.el.classList.contains('leaving');
    this.el.classList.remove('leaving');
    this.el.hidden = false;
    // Come in again for the new text (the CSS animation restarts with the class)
    this.box.classList.remove('enter');
    void this.box.offsetWidth;
    this.box.classList.add('enter');
  }

  private hide(): void {
    this.ring.hidden = true;
    if (this.shownKey === null) return;
    this.shownKey = null;
    if (reducedMotion()) {
      this.el.hidden = true;
      return;
    }
    this.el.classList.add('leaving');
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.el.hidden = true;
      this.el.classList.remove('leaving');
    }, EXIT_MS);
  }

  // Next to the hero it is about (above it, or below when there is no room), else at the top
  // of the battlefield (play) or its lower right corner (watch, by the side panel)
  private place(kind: HintKind): void {
    // The battlefield's box in the page (the canvas follows it a frame later, after a resize)
    const canvas = this.renderer.getViewSize();
    const view = {
      width: this.area.clientWidth || canvas.width,
      height: this.area.clientHeight || canvas.height,
    };
    const w = this.el.offsetWidth || 300;
    const h = this.el.offsetHeight || 90;
    const target = kind === 'play' ? this.target() : null;
    let x: number;
    let y: number;
    let caret: 'above' | 'below' | null = null;
    let caretX = 0;
    const cam = this.renderer.getCamera();
    const sx = target ? (target.position.x - cam.x) * cam.zoom : -1;
    const sy = target ? (target.position.y - cam.y) * cam.zoom : -1;
    const onScreen = target !== null && sx >= 0 && sy >= 0 && sx <= view.width && sy <= view.height;
    if (onScreen) {
      const gap = Math.max(24, cam.zoom * 2.4);
      x = clamp(sx - w / 2, MARGIN, view.width - w - MARGIN);
      y = sy - gap - h;
      caret = 'above';
      if (y < MARGIN) {
        y = sy + gap;
        caret = 'below';
      }
      y = clamp(y, MARGIN, view.height - h - MARGIN);
      caretX = clamp(sx - x, 14, w - 14);
      const size = Math.round(Math.max(30, cam.zoom * 3.2));
      this.ring.style.width = this.ring.style.height = `${size}px`;
      moveTo(this.ring, sx - size / 2, sy - size / 2, this.ring.hidden);
    } else if (kind === 'play') {
      x = (view.width - w) / 2;
      y = MARGIN + 2;
    } else {
      x = view.width - w - MARGIN;
      y = view.height - h - MARGIN;
    }
    this.ring.hidden = !onScreen;
    this.el.classList.toggle('above', caret === 'above');
    this.el.classList.toggle('below', caret === 'below');
    this.caret.style.left = `${Math.round(caretX)}px`;
    moveTo(this.el, Math.max(0, x), Math.max(0, y), this.fresh);
    this.fresh = false;
  }

  // The hero the play hint points at: one of the user's heroes (first step), then the selected
  // one (second step)
  private target(): IUnit | null {
    if (this.step === 1) {
      const sel = this.selectedId ? this.stateManager.getUnitById(this.selectedId) : undefined;
      return sel && sel.hp > 0 ? sel : null;
    }
    if (this.step !== 0) return null;
    let best: IHero | null = null;
    for (const h of this.stateManager.getHeroes())
      if (isOwnHero(h) && h.hp > 0 && (!best || h.heroIndex < best.heroIndex)) best = h;
    return best;
  }
}

function isOwnHero(unit: IUnit): boolean {
  return (
    unit.unitType === UnitType.HERO &&
    unit.faction === Faction.FRIENDLY &&
    (unit as IHero).controller === 'user'
  );
}

// What can be done while watching; the AI panels are mentioned when they are shown
function watchText(replay: boolean): string {
  const panels = ['ai-col-west', 'ai-col-east'].some((id) => {
    const el = document.getElementById(id);
    return !!el && !el.hidden;
  });
  return (
    (replay
      ? 'A recorded battle: the bar at the top plays, jumps and exits it. '
      : 'The AI commanders are in charge. ') +
    'Click a unit to see its state; drag on the map to count an area.' +
    (panels ? ' The side panel shows what each AI decided and why (scroll down).' : '')
  );
}

// Moves an element of the layer (CSS eases it along with the hero, 100 ms); `jump` places it at
// once, so a hint that appears does not glide in from where it was last
function moveTo(el: HTMLElement, x: number, y: number, jump: boolean): void {
  const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  if (el.style.transform === transform) return;
  if (jump) el.classList.add('jump');
  el.style.transform = transform;
  if (jump) {
    void el.offsetWidth; // apply the place before the transition is back
    el.classList.remove('jump');
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
