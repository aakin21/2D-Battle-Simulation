import { Faction, UnitType } from '../types/types';
import warriorUrl from '../assets/sprites/warrior_knight.png';
import berserkerUrl from '../assets/sprites/berserker_lion.png';
import heroKnightGoldUrl from '../assets/sprites/hero_knight_gold.png';
import heroMasterUrl from '../assets/sprites/hero_master.png';
import heroSamuraiUrl from '../assets/sprites/hero_samurai.png';
import heroShamanLionUrl from '../assets/sprites/hero_shaman_lion.png';
import heroLionOrangeUrl from '../assets/sprites/hero_lion_orange.png';
import heroTenguUrl from '../assets/sprites/hero_tengu.png';

// Unit sprites from the Ninja Adventure asset pack (CC0, see src/assets/sprites/LICENSE.txt
// and THESIS_DOCUMENTATION.md D25).
//
// Sheet layout (64×112, 16×16 frames), verified against the pack's separate animations:
//   columns: 0 facing down, 1 up, 2 left, 3 right
//   rows 0–3: walk cycle (row 0 doubles as the idle pose), row 4: attack, row 6 col 0: dead
//
// Warriors and berserkers are tinted toward their team color so sides stay readable in a
// crowd. Heroes keep their own colors so they stand out. Each sheet also gets a white
// silhouette (hit flash) and a darkened copy (corpses), all built once at load time.

export const FRAME = 16;
export const COL_LEFT = 2;
export const COL_RIGHT = 3;
export const WALK_FRAMES = 4;
export const ROW_ATTACK = 4;
export const ROW_DEAD = 6;

// How strongly team color replaces the original colors (0 = original, 1 = fully tinted)
const TINT_STRENGTH = 0.8;
// Pixels darker than this keep their color, so outlines stay crisp
const OUTLINE_LUMA = 0.16;
const CORPSE_DARKEN = 0.6;

const TEAM_RGB: Record<string, [number, number, number]> = {
  WARRIOR: [255, 215, 0], // UNIT_COLORS.WARRIOR
  BERSERKER: [65, 105, 225], // UNIT_COLORS.BERSERKER
};

// Hero sprites per side, in hero order. Phase 1 has a single friendly hero; the rest are
// ready for symmetric sides with 3 heroes each (D13).
const HERO_URLS: Record<Faction, string[]> = {
  [Faction.FRIENDLY]: [heroKnightGoldUrl, heroMasterUrl, heroSamuraiUrl],
  [Faction.ENEMY]: [heroShamanLionUrl, heroLionOrangeUrl, heroTenguUrl],
};

export interface SheetSet {
  normal: HTMLCanvasElement;
  flash: HTMLCanvasElement;
  dark: HTMLCanvasElement;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  return img.decode().then(() => img);
}

function toCanvas(img: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return c;
}

// Applies fn to every opaque pixel of a copy of src
function mapPixels(
  src: HTMLCanvasElement,
  fn: (p: Uint8ClampedArray, i: number) => void
): HTMLCanvasElement {
  const c = toCanvas(src, src.width, src.height);
  const ctx = c.getContext('2d')!;
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const p = data.data;
  for (let i = 0; i < p.length; i += 4) if (p[i + 3] > 0) fn(p, i);
  ctx.putImageData(data, 0, 0);
  return c;
}

function luma(p: Uint8ClampedArray, i: number): number {
  return (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) / 255;
}

function buildSet(img: HTMLImageElement, team: [number, number, number] | null): SheetSet {
  let normal = toCanvas(img, img.width, img.height);
  if (team) {
    normal = mapPixels(normal, (p, i) => {
      const l = luma(p, i);
      if (l < OUTLINE_LUMA) return;
      const k = 0.35 + 0.9 * l; // keeps the sprite's shading
      for (let ch = 0; ch < 3; ch++) {
        p[i + ch] = p[i + ch] * (1 - TINT_STRENGTH) + Math.min(255, team[ch] * k) * TINT_STRENGTH;
      }
    });
  }
  const flash = mapPixels(normal, (p, i) => {
    p[i] = p[i + 1] = p[i + 2] = 255;
  });
  const dark = mapPixels(normal, (p, i) => {
    p[i] *= CORPSE_DARKEN;
    p[i + 1] *= CORPSE_DARKEN;
    p[i + 2] *= CORPSE_DARKEN;
  });
  return { normal, flash, dark };
}

export class UnitSprites {
  private warrior: SheetSet | null = null;
  private berserker: SheetSet | null = null;
  private heroes: Record<Faction, SheetSet[]> = { [Faction.FRIENDLY]: [], [Faction.ENEMY]: [] };

  // Loads and prepares all sheets. Until it resolves, isReady() is false and the
  // renderer keeps drawing squares.
  async load(warmTarget?: CanvasRenderingContext2D): Promise<void> {
    const [w, b, ...heroImgs] = await Promise.all([
      loadImage(warriorUrl),
      loadImage(berserkerUrl),
      ...HERO_URLS[Faction.FRIENDLY].map(loadImage),
      ...HERO_URLS[Faction.ENEMY].map(loadImage),
    ]);
    const n = HERO_URLS[Faction.FRIENDLY].length;
    this.warrior = buildSet(w, TEAM_RGB.WARRIOR);
    this.berserker = buildSet(b, TEAM_RGB.BERSERKER);
    this.heroes[Faction.FRIENDLY] = heroImgs.slice(0, n).map((img) => buildSet(img, null));
    this.heroes[Faction.ENEMY] = heroImgs.slice(n).map((img) => buildSet(img, null));

    // Upload every canvas to the GPU now, so the first zoom-in causes no hitch
    if (warmTarget) {
      const all = [this.warrior, this.berserker, ...this.heroes[0], ...this.heroes[1]];
      for (const set of all) {
        for (const c of [set.normal, set.flash, set.dark]) warmTarget.drawImage(c, 0, 0, 1, 1);
      }
    }
  }

  isReady(): boolean {
    return this.warrior !== null;
  }

  // heroIndex: position of the hero within its side (0 for Phase 1's single hero)
  get(unitType: UnitType, faction: Faction, heroIndex: number = 0): SheetSet {
    if (unitType === UnitType.WARRIOR) return this.warrior!;
    if (unitType === UnitType.BERSERKER) return this.berserker!;
    const list = this.heroes[faction];
    return list[heroIndex % list.length];
  }
}
