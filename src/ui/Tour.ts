import { BATTLE_CONFIG, DEFAULT_CONFIG } from '../types/types';
import { LLM_INTERVAL_SEC } from '../ai/LlmController';
import { JEV_INTERVAL_SEC } from '../ai/GameRules';

// The guided tour of a menu screen: the "?" button of the title screen, Match setup or the
// Sandbox walks through the screen's parts one at a time. Each step lights one part up and says
// what it is in a box next to it; Next, Back and Close (or the arrow keys, Enter and Esc) move
// through it. A step whose part is not on screen now (a model list on a side nobody's LLM
// commands) is left out. The tour only points and explains: it changes no setting, starts
// nothing, asks no AI server and uses no Math.random.

type TourName = 'title' | 'setup' | 'sandbox';

interface Step {
  // The part the step is about: the first of these selectors that is on screen
  target: string[];
  title: string;
  text: string | (() => string);
}

const visible = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el.getClientRects().length > 0;

const TOURS: Record<TourName, Step[]> = {
  title: [
    {
      target: ['#menu-continue', '#title-play'],
      title: 'Quick battle',
      text: `One click starts a battle: you command the West army's ${BATTLE_CONFIG.heroesPerSide} heroes against the built-in rules. Short hints show you how to give orders.`,
    },
    {
      target: ['#title-ai'],
      title: 'AI vs AI',
      text: 'Opens Match setup, where you choose who commands each side: an LLM (a large language model), the built-in rules or you. It starts with an LLM on both sides: choose their models, then watch them fight, or take a side yourself.',
    },
    {
      target: ['.choice-pair'],
      title: 'Watch a recorded battle',
      text: 'Plays a battle that was recorded earlier, or opens a .replay file you saved from one of your own.',
    },
    {
      target: ['#title-sandbox'],
      title: 'Sandbox',
      text: `The first version of the simulation: your hero and ${DEFAULT_CONFIG.warriorCount} warriors against waves of berserkers, your own army sizes, and a stress test.`,
    },
    {
      target: ['#conn-server'],
      title: 'AI server',
      text: 'This page has an AI server of its own, so an LLM side needs nothing connected: it runs there. Match setup lists the models it runs.',
    },
    {
      target: ['#conn-openrouter'],
      title: 'OpenRouter',
      text: 'The main way to reach a model: your own OpenRouter account, with the models of every company and nothing to install. Connect opens openrouter.ai, where you allow this site a key of your account.',
    },
    {
      target: ['#conn-bridge', '#conn-own'],
      title: 'Or your own computer',
      text: 'What you have on your own computer: Ollama (or another local model server), Claude Code, Codex. One command in a terminal starts the AI bridge, which connects this page to them.',
    },
    {
      target: ['.title-links'],
      title: 'More',
      text: 'Controls lists the mouse and the keys. About says what this project is.',
    },
  ],
  setup: [
    {
      target: ['#setup-west'],
      title: 'Two sides',
      text: 'West is on the left, East on the right, and what they fight for is between them. Each side is set up on its own.',
    },
    {
      target: ['#cfg-west'],
      title: 'Who commands the side',
      text: `You: you order the heroes with the mouse. LLM: a large language model gives every hero a strategic order every ${LLM_INTERVAL_SEC} s. LLM + Jev or LLM + Snap: the LLM plans, and a fast decision model adjusts each hero's order every ${JEV_INTERVAL_SEC} s.`,
    },
    {
      target: ['#cfg-west-way', '#cfg-east-way'],
      title: 'Where the LLM runs',
      text: 'Only the ways this page can use are offered: its own AI server, your OpenRouter account, or this computer through the AI bridge (local models, Claude, Codex, Gemini, a command of your own).',
    },
    {
      target: ['#pick-west', '#pick-east'],
      title: 'The model',
      text: 'The model that commands this side, from what its way runs; what it cannot run is listed greyed out, with why. Two different models on the two sides make a comparison; the same model on both is a mirror match.',
    },
    {
      target: ['#connect-west', '#connect-east'],
      title: 'Not connected yet',
      text: 'This way is not connected. Press the button to connect it; the list of its models appears here afterwards.',
    },
    {
      target: ['#cfg-opponent'],
      title: 'The other side',
      text: 'East is set up the same way. Rules are the built-in heroes without any AI: they attack what they see and go for the objective.',
    },
    {
      target: ['#cfg-objective'],
      title: 'What wins',
      text: 'Elimination: destroy every enemy unit. Control: hold the points A and B and score for the time you hold them. Base: destroy the enemy base. The line below says how the chosen one is decided.',
    },
    {
      target: ['#cfg-map'],
      title: 'Map and armies',
      text: 'A new random map, the fixed one, or a map you saved; below it the soldiers per side and how much forest and swamp the map has.',
    },
    {
      target: ['#row-timing'],
      title: 'AI timing',
      text: 'Real-time: the battle goes on while the AI thinks, so a slow answer arrives late. Paused: the battle waits for every answer, which is fair to slow models and much slower to watch.',
    },
    {
      target: ['#cfg-replay'],
      title: 'Replay',
      text: 'Record keeps the battle, so you can watch it again afterwards or download it as a file.',
    },
    {
      target: ['#menu-start'],
      title: 'Start',
      text: 'Starts the battle. If something is missing, a model or a connection, a message says so next to the part it concerns.',
    },
  ],
  sandbox: [
    {
      target: ['#menu-tabs'],
      title: 'Three modes',
      text: 'Classic is the first version of the simulation with its original numbers. Custom lets you change them. The stress test fills the map with thousands of units to measure speed.',
    },
    {
      target: ['.sandbox-card'],
      title: 'The settings',
      text: 'The map, the number of warriors, how strong the berserker waves are and the terrain. In Classic they are locked at the original values.',
    },
    {
      target: ['#sandbox-start'],
      title: 'Start',
      text: 'Starts the run. You lead one hero: right-click the map to move it, and its warriors follow.',
    },
  ],
};

const LS_SEEN = 'sim_tour_seen';

function seen(): boolean {
  try {
    return localStorage.getItem(LS_SEEN) === '1';
  } catch {
    return true; // no storage: never nudge
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(LS_SEEN, '1');
  } catch {
    // not kept
  }
}

export class Tour {
  private root: HTMLElement;
  private spot: HTMLElement;
  private box: HTMLElement;
  private elCount: HTMLElement;
  private elTitle: HTMLElement;
  private elText: HTMLElement;
  private btnBack: HTMLButtonElement;
  private btnNext: HTMLButtonElement;
  private steps: { step: Step; el: HTMLElement }[] = [];
  private index = 0;
  private opener: HTMLElement | null = null;

  constructor() {
    this.root = document.getElementById('tour')!;
    this.spot = document.getElementById('tour-spot')!;
    this.box = document.getElementById('tour-box')!;
    this.elCount = document.getElementById('tour-count')!;
    this.elTitle = document.getElementById('tour-title')!;
    this.elText = document.getElementById('tour-text')!;
    this.btnBack = document.getElementById('tour-back') as HTMLButtonElement;
    this.btnNext = document.getElementById('tour-next') as HTMLButtonElement;

    for (const button of Array.from(document.querySelectorAll<HTMLElement>('.tour-open'))) {
      button.classList.toggle('nudge', !seen());
      button.addEventListener('click', () => this.open(button.dataset.tour as TourName, button));
    }
    this.btnBack.addEventListener('click', () => this.go(this.index - 1));
    this.btnNext.addEventListener('click', () => this.go(this.index + 1));
    document.getElementById('tour-close')!.addEventListener('click', () => this.close());
    window.addEventListener('resize', () => this.place());
    // The tour's keys go no further: Esc would leave the screen, Space is a shortcut
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.isOpen()) return;
        if (e.key === 'Escape') this.close();
        else if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ')
          this.go(this.index + 1);
        else if (e.key === 'ArrowLeft') this.go(this.index - 1);
        else if (e.key !== 'Tab') return;
        else {
          this.keepFocus(e);
          return;
        }
        e.preventDefault();
        e.stopPropagation();
      },
      true
    );
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  // Starts the tour of a screen with the parts that are on screen now
  open(name: TourName, opener: HTMLElement | null = null): void {
    this.steps = [];
    for (const step of TOURS[name] ?? []) {
      const el = step.target.map((s) => document.querySelector(s)).find(visible);
      if (el) this.steps.push({ step, el });
    }
    if (this.steps.length === 0) return;
    this.opener = opener;
    markSeen();
    document.querySelectorAll('.tour-open').forEach((button) => button.classList.remove('nudge'));
    this.root.hidden = false;
    this.go(0);
  }

  close(): void {
    if (!this.isOpen()) return;
    this.root.hidden = true;
    this.opener?.focus();
    this.opener = null;
  }

  private go(index: number): void {
    if (index >= this.steps.length) return this.close();
    this.index = Math.max(0, index);
    const { step, el } = this.steps[this.index];
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.elCount.textContent = `${this.index + 1}/${this.steps.length}`;
    this.elTitle.textContent = step.title;
    this.elText.textContent = typeof step.text === 'function' ? step.text() : step.text;
    this.btnBack.disabled = this.index === 0;
    this.btnNext.textContent = this.index === this.steps.length - 1 ? 'Done' : 'Next';
    // The box comes in again with each step
    this.box.classList.remove('enter');
    void this.box.offsetWidth;
    this.box.classList.add('enter');
    this.place();
    this.btnNext.focus();
  }

  // The light around the step's part, and the box under it (above it when there is no room)
  private place(): void {
    if (!this.isOpen()) return;
    const r = this.steps[this.index].el.getBoundingClientRect();
    const pad = 6;
    const gap = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const spot = {
      left: Math.max(2, Math.round(r.left - pad)),
      top: Math.max(2, Math.round(r.top - pad)),
      right: Math.min(vw - 2, Math.round(r.right + pad)),
      bottom: Math.min(vh - 2, Math.round(r.bottom + pad)),
    };
    this.spot.style.left = `${spot.left}px`;
    this.spot.style.top = `${spot.top}px`;
    this.spot.style.width = `${spot.right - spot.left}px`;
    this.spot.style.height = `${spot.bottom - spot.top}px`;

    const bw = this.box.offsetWidth;
    const bh = this.box.offsetHeight;
    const below = spot.bottom + gap + bh <= vh - 8;
    const above = spot.top - gap - bh >= 8;
    // Beside the part when it fills the height (a whole card)
    let top = below ? spot.bottom + gap : above ? spot.top - gap - bh : vh - bh - 8;
    let left = Math.round((spot.left + spot.right) / 2 - bw / 2);
    if (!below && !above) {
      const rightRoom = vw - spot.right - gap - bw >= 8;
      const leftRoom = spot.left - gap - bw >= 8;
      if (rightRoom || leftRoom) {
        left = rightRoom ? spot.right + gap : spot.left - gap - bw;
        top = Math.round((spot.top + spot.bottom) / 2 - bh / 2);
      }
    }
    left = Math.max(8, Math.min(left, vw - bw - 8));
    top = Math.max(8, Math.min(top, vh - bh - 8));
    this.box.style.left = `${left}px`;
    this.box.style.top = `${top}px`;
    this.box.dataset.side = below ? 'below' : above ? 'above' : 'beside';
  }

  // Tab stays among the tour's own buttons while it is open
  private keepFocus(e: KeyboardEvent): void {
    const buttons = Array.from(
      this.box.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.shiftKey
      ? at <= 0
        ? buttons.length - 1
        : at - 1
      : at === buttons.length - 1
        ? 0
        : at + 1;
    e.preventDefault();
    e.stopPropagation();
    buttons[next].focus();
  }
}
