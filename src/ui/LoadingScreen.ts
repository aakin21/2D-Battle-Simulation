import { Faction, SimConfig } from '../types/types';
import { heroSpriteUrls, UNIT_SPRITE_URLS } from '../rendering/UnitSprites';
import { sideCommander } from './Hud';

// The match intro shown after Start: who fights whom and for what, for about two seconds. The
// run is already set up and waits paused behind it, so nothing is loaded here and no progress is
// faked; a click, Enter or Space ends it at once. It shows what the run is, never changes it.

export type LoadingKind = 'classic' | 'stress' | 'battle';

const DURATION_MS = 2000;
const REDUCED_MS = 900; // prefers-reduced-motion: no entrances to wait for
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
  private skip: (() => void) | null = null;

  constructor() {
    this.el = document.getElementById('loading-overlay')!;
    this.el.addEventListener('click', () => this.skip?.());
    // Enter or Space ends the intro; the key goes no further (Space would pause the run)
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.skip || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        e.stopPropagation();
        this.skip();
      },
      true
    );
  }

  isActive(): boolean {
    return this.active;
  }

  // Shows the intro of a run, then fades out. Resolves when it is hidden.
  async run(kind: LoadingKind, cfg: SimConfig): Promise<void> {
    this.fill(introFor(kind, cfg));
    this.active = true;
    this.el.dataset.kind = kind;
    this.el.classList.remove('fading');
    this.el.style.display = 'flex';

    const skipped = new Promise<void>((resolve) => {
      this.skip = resolve;
    });
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    await Promise.race([wait(reduced ? REDUCED_MS : DURATION_MS), skipped]);
    this.skip = null;

    this.el.classList.add('fading');
    await wait(FADE_MS);
    this.el.style.display = 'none';
    this.active = false;
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
