import { Faction, SimConfig } from '../types/types';
import { heroSpriteUrls, UNIT_SPRITE_URLS } from '../rendering/UnitSprites';
import { sideCommander } from './Hud';

// The match intro shown after Start: who fights whom and for what. The run is already set up and
// waits paused behind it, so nothing is loaded here and no progress is faked. It stays until the
// player starts the battle: a click on it, Enter or Space (2026-11-22: it ended by itself after
// about two seconds). It shows what the run is, never changes it.

export type LoadingKind = 'classic' | 'stress' | 'battle';

const FADE_MS = 250; // matches the CSS opacity transition

const OBJECTIVE_LINE: Record<string, string> = {
  elimination: 'Elimination: destroy every enemy unit',
  control: 'Control: hold the points A and B',
  base: 'Base: destroy the enemy base',
};

interface Side {
  name: string;
  who: string;
  sprites: string[];
}

interface Intro {
  west: Side;
  east: Side;
  line: string;
}

// What the intro says about a run of this kind and configuration
function introFor(kind: LoadingKind, cfg: SimConfig): Intro {
  if (kind === 'battle') {
    const heroes = (faction: Faction) => heroSpriteUrls(faction).slice(0, cfg.heroesPerSide);
    return {
      west: {
        name: 'West',
        who: sideCommander(cfg, Faction.FRIENDLY),
        sprites: heroes(Faction.FRIENDLY),
      },
      east: {
        name: 'East',
        who: sideCommander(cfg, Faction.ENEMY),
        sprites: heroes(Faction.ENEMY),
      },
      line: `${OBJECTIVE_LINE[cfg.objective ?? 'elimination']} · ${cfg.warriorCount} soldiers per side`,
    };
  }
  const west: Side = {
    name: 'Warriors',
    who: 'You lead their hero',
    sprites: [
      UNIT_SPRITE_URLS.warrior,
      heroSpriteUrls(Faction.FRIENDLY)[0],
      UNIT_SPRITE_URLS.warrior,
    ],
  };
  const east: Side = {
    name: 'Berserkers',
    who: 'They come in waves',
    sprites: [UNIT_SPRITE_URLS.berserker, UNIT_SPRITE_URLS.berserker, UNIT_SPRITE_URLS.berserker],
  };
  return {
    west,
    east,
    line:
      kind === 'stress'
        ? 'Stress test: 2200 warriors against 2000 berserkers'
        : `Classic mode: ${cfg.warriorCount} warriors hold out against waves of berserkers`,
  };
}

export class LoadingScreen {
  private el: HTMLElement;
  private active: boolean = false;
  private begin: (() => void) | null = null;

  constructor() {
    this.el = document.getElementById('loading-overlay')!;
    this.el.addEventListener('click', () => this.begin?.());
    // While it is shown it has the keyboard. Enter or Space starts the battle and goes no further
    // (Space would also pause the run); a held key's repeats start nothing (Enter held from
    // pressing Start). Tab stays on it: nothing behind it is reachable. Other keys go on to the
    // page, which ignores them while it is shown.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.active) return;
        if (e.key === 'Tab') {
          e.preventDefault();
          return;
        }
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) this.begin?.();
      },
      true
    );
  }

  isActive(): boolean {
    return this.active;
  }

  // Shows the intro of a run until the player starts the battle, then fades out. Resolves when it
  // is hidden. No timer: however long it waits, the run behind it stays paused.
  async run(kind: LoadingKind, cfg: SimConfig): Promise<void> {
    this.fill(introFor(kind, cfg));
    const back = document.activeElement as HTMLElement | null;
    this.active = true;
    this.el.dataset.kind = kind;
    this.el.classList.remove('fading');
    this.el.style.display = 'flex';
    // The focus on it (a modal dialog with its label, index.html): Enter works at once and a
    // screen reader says what it is
    this.el.focus();

    await new Promise<void>((resolve) => {
      this.begin = resolve;
    });
    this.begin = null;

    this.el.classList.add('fading');
    await wait(FADE_MS);
    this.el.style.display = 'none';
    this.active = false;
    // The focus back where it was while that is still on screen (Start's button went with the
    // menu: then the page has it)
    if (back && back !== document.body && back.isConnected && back.getClientRects().length > 0)
      back.focus();
    else if (document.activeElement === this.el) this.el.blur();
  }

  private fill(intro: Intro): void {
    for (const [id, side] of [
      ['intro-west', intro.west],
      ['intro-east', intro.east],
    ] as const) {
      document.getElementById(`${id}-name`)!.textContent = side.name;
      document.getElementById(`${id}-who`)!.textContent = side.who;
      const units = document.getElementById(`${id}-units`)!;
      units.replaceChildren(
        ...side.sprites.map((url) => {
          const unit = document.createElement('span');
          unit.className = 'intro-unit';
          // Sprite URLs are hashed by the bundler, so they are set from code
          unit.style.backgroundImage = `url(${url})`;
          return unit;
        })
      );
    }
    document.getElementById('intro-line')!.textContent = intro.line;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
