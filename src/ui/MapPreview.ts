import { Faction, GRID_SIZE, Objective, Position, TerrainType } from '../types/types';
import {
  drawHeroMarker,
  drawObjectiveMarkers,
  flatTerrainPixels,
} from '../rendering/MinimapRenderer';
import { SIDE_RGB } from '../rendering/SideColors';
import {
  EAST_HERO_COLUMN,
  WEST_HERO_COLUMN,
  heroSlotRow,
  mainRegionOf,
  nearestMainTile,
  objectivePlaces,
  soldierColumns,
} from '../state/BattleLayout';

// Match setup's map preview (battle mode only): the map that will be played, drawn as the minimap
// draws it (flat terrain colours, one tile a square of whole pixels, its control point and base
// markers), with where each army starts (its soldiers' columns shaded in its colour, its heroes'
// squares) and, for Control, the points A and B with their capture radius, for Base both bases.
// The places come from BattleLayout, as the run's do. A picture, not a control: the canvas is an
// image with a description (aria-label) and never takes the focus. Nothing random here.

// Canvas pixels per tile: 2 (a 300 px square), 3 in a large window (450 px; menu.css's same query)
const LARGE_WINDOW = '(min-width: 1800px) and (min-height: 1000px)';
const INK = '#131b1b';
const LABEL = '#fff4dc';
const AREA_FILL = SIDE_RGB.map((rgb) => `rgba(${rgb}, 0.22)`);
const AREA_EDGE = SIDE_RGB.map((rgb) => `rgb(${rgb})`);

// What the preview shows now, in tiles (the tests compare it with the run Start sets up)
export interface PreviewLayout {
  objective: Objective;
  points: { name: string; position: Position }[];
  bases: { faction: Faction; position: Position }[];
  heroes: { faction: Faction; slot: Position; position: Position }[];
  areas: { faction: Faction; from: number; to: number }[];
}

// Which map is shown: `key` tells maps apart (the preview comes in again when it changes), `name`
// says it in the description ("a random map", "the fixed map", 'the saved map "x"')
export interface PreviewMap {
  key: string;
  name: string;
}

// Pixel glyphs: the control points' names (5×7) and a base's tower (7×6)
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  tower: ['1010101', '1111111', '1111111', '1110111', '1110111', '1110111'],
};

const OBJECTIVE_NAME: Record<Objective, string> = {
  elimination: 'Elimination',
  control: 'Control',
  base: 'Base',
};
const WHAT: Record<Objective, string> = {
  elimination: 'the two armies face each other',
  control: 'points A and B between the armies',
  base: "each army's base behind it",
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class MapPreview {
  private box = $('map-preview-box');
  private canvas = $('map-preview') as HTMLCanvasElement;
  private note = $('map-preview-note');
  private legend = $('map-preview-legend');
  private layer: HTMLCanvasElement | null = null;
  private large: MediaQueryList | null =
    typeof window.matchMedia === 'function' ? window.matchMedia(LARGE_WINDOW) : null;
  private shownKey = '';
  // What is drawn now (null: no preview, the note says why), on which map, at how many canvas
  // pixels per tile
  layout: PreviewLayout | null = null;
  grid: TerrainType[][] | null = null;
  scale = 2;

  constructor() {
    // A window that becomes large or small: the same map at the other scale
    this.large?.addEventListener?.('change', () => {
      if (this.grid && this.layout) this.draw(this.grid, this.layout);
    });
  }

  // Draws `grid` with the places of `objective` and the armies of `heroesPerSide` heroes
  show(grid: TerrainType[][], objective: Objective, heroesPerSide: number, map: PreviewMap): void {
    const layout = layoutOf(grid, objective, heroesPerSide);
    const key = `${map.key}|${objective}`;
    const changed = key !== this.shownKey;
    this.shownKey = key;
    this.grid = grid;
    this.layout = layout;
    this.draw(grid, layout);
    this.box.dataset.state = 'shown';
    this.box.dataset.objective = objective;
    this.canvas.hidden = false;
    this.note.hidden = true;
    this.note.textContent = '';
    this.canvas.setAttribute(
      'aria-label',
      `${OBJECTIVE_NAME[objective]}: ${WHAT[objective]}, West on the left, East on the right, on ${map.name}.`
    );
    this.legend.hidden = false;
    this.showLegend(objective);
    // A short whole-step entrance when what is shown changes (menu-fx.css; none with reduced motion)
    if (changed) {
      this.box.classList.remove('changed');
      void this.box.offsetWidth;
      this.box.classList.add('changed');
    }
  }

  // No preview: the map cannot be shown, and the note says why
  none(why: string): void {
    this.grid = null;
    this.layout = null;
    this.shownKey = '';
    this.box.dataset.state = 'none';
    delete this.box.dataset.objective;
    this.canvas.hidden = true;
    this.canvas.removeAttribute('aria-label');
    this.legend.hidden = true;
    this.note.textContent = why;
    this.note.hidden = false;
  }

  private showLegend(objective: Objective): void {
    const item = (cls: string, label: string) =>
      `<span class="lg-item"><span class="lg-mark ${cls}" aria-hidden="true"></span>${label}</span>`;
    const extra =
      objective === 'control'
        ? item('lg-point', 'Points')
        : objective === 'base'
          ? item('lg-base', 'Bases')
          : '';
    // Fixed text only (no user input), so it is set as HTML
    this.legend.innerHTML = item('lg-west', 'West') + item('lg-east', 'East') + extra;
  }

  private draw(grid: TerrainType[][], layout: PreviewLayout): void {
    const s = this.large?.matches ? 3 : 2;
    this.scale = s;
    const size = GRID_SIZE * s;
    const canvas = this.canvas;
    canvas.dataset.scale = String(s);
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) return; // a page without canvas drawing (the tests' fake DOM)
    if (canvas.width !== size) canvas.width = size;
    if (canvas.height !== size) canvas.height = size;

    // The terrain at one pixel per tile, scaled up by whole pixels (the minimap's)
    if (!this.layer) {
      this.layer = document.createElement('canvas');
      this.layer.width = GRID_SIZE;
      this.layer.height = GRID_SIZE;
    }
    const lctx = this.layer.getContext('2d');
    const image = lctx?.createImageData(GRID_SIZE, GRID_SIZE);
    if (!lctx || !image?.data) return; // the tests' fake DOM: a context that draws nothing
    image.data.set(flatTerrainPixels(grid));
    lctx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.layer, 0, 0, size, size);

    // Each army's start: its soldiers' columns shaded, a dashed line on the edge towards the enemy
    for (const a of layout.areas) {
      ctx.fillStyle = AREA_FILL[a.faction];
      ctx.fillRect(a.from * s, 0, (a.to - a.from) * s, size);
      ctx.fillStyle = AREA_EDGE[a.faction];
      const edge = a.faction === Faction.FRIENDLY ? (a.to - 1) * s : a.from * s;
      for (let y = 0; y < size; y += 4 * s) ctx.fillRect(edge, y, s, 2 * s);
    }

    // Control points and bases as the minimap draws them (nobody holds a point yet)
    drawObjectiveMarkers(
      ctx,
      {
        points: layout.points.map((p) => ({ ...p, holder: null, leader: null, leaderSince: 0 })),
        bases: layout.bases.map((b) => ({ ...b, hp: 1, maxHp: 1 })),
      },
      s
    );
    // Their names, and each base as a tower in its side's colour
    const at = (p: Position) => [(p.x + 0.5) * s, (p.y + 0.5) * s] as const;
    for (const p of layout.points) drawGlyph(ctx, p.name, LABEL, s, ...at(p.position));
    for (const b of layout.bases)
      drawGlyph(ctx, 'tower', AREA_EDGE[b.faction], s, ...at(b.position));

    // Heroes: the minimap's squares, a little larger
    for (const h of layout.heroes) drawHeroMarker(ctx, ...at(h.position), h.faction, 5 * s);
  }
}

// The places of a battle on this map, as StateManager sets them up (BattleLayout): the objective's
// points or bases, each hero on the main region's tile nearest to its slot (the run puts it on a
// random clear tile in a small square around the slot), each side's soldier columns
export function layoutOf(
  grid: TerrainType[][],
  objective: Objective,
  heroesPerSide: number
): PreviewLayout {
  const region = mainRegionOf(grid);
  const places = objectivePlaces(region, objective);
  const heroes: PreviewLayout['heroes'] = [];
  const areas: PreviewLayout['areas'] = [];
  const count = Math.max(1, heroesPerSide);
  for (const [faction, column] of [
    [Faction.FRIENDLY, WEST_HERO_COLUMN],
    [Faction.ENEMY, EAST_HERO_COLUMN],
  ] as const) {
    for (let h = 0; h < count; h++) {
      const slot = { x: column, y: heroSlotRow(h, count) };
      heroes.push({ faction, slot, position: nearestMainTile(region, slot.x, slot.y) });
    }
    areas.push({ faction, ...soldierColumns(column) });
  }
  return { objective, ...places, heroes, areas };
}

// A glyph in `color`, each of its pixels px × px, on a dark plate, centred on (cx, cy)
function drawGlyph(
  ctx: CanvasRenderingContext2D,
  name: string,
  color: string,
  px: number,
  cx: number,
  cy: number
): void {
  const rows = GLYPHS[name];
  if (!rows) return;
  const w = rows[0].length * px;
  const h = rows.length * px;
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(cy - h / 2);
  ctx.fillStyle = INK;
  ctx.fillRect(x0 - px, y0 - px, w + 2 * px, h + 2 * px);
  ctx.fillStyle = color;
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++)
      if (row[i] === '1') ctx.fillRect(x0 + i * px, y0 + j * px, px, px);
  });
}
