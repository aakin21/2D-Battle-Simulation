import { encodeGrid, decodeGrid } from '../state/MapStore';
import { Faction, HeroCommand, Position, SimConfig, TerrainType, UnitType } from '../types/types';

// A recorded battle-mode match: every unit's place, HP, state and courage a few times per
// second, the heroes' orders, the objective, and the side panels as they were shown, so the
// match can be watched again (ReplayPlayer) without running the simulation. Kept in memory while
// the match runs and saved as a gzip-compressed file: a JSON header, then the frames as binary
// columns with positions stored as changes since the previous frame (they compress well).

export const REPLAY_FORMAT = 'battle-replay';
export const REPLAY_VERSION = 1;
// Positions are kept in tenths of a tile
export const POS_SCALE = 10;

// What does not change during a unit's life
export interface ReplayUnit {
  id: string;
  type: UnitType;
  faction: Faction;
  maxHp: number;
  sight: number;
  heroIndex?: number;
  charismaRadius?: number;
}

export interface ReplayHero {
  i: number; // index in `units`
  taskPoint: Position | null;
  command: HeroCommand | null;
  commandTime: number; // the marker's "new order" ring is drawn when this changes
}

export interface ReplayObjective {
  holders: (Faction | null)[]; // per control point
  scores: { friendly: number; enemy: number };
  baseHp: number[]; // per base
}

// One frame: the living units in columns (index into `units`, then their values)
export interface ReplayFrame {
  t: number;
  idx: Uint16Array;
  x: Int16Array; // tenths of a tile
  y: Int16Array;
  hp: Uint16Array;
  state: Uint8Array;
  courage: Uint8Array;
  heroes: ReplayHero[];
  objective: ReplayObjective;
}

// A side panel's HTML from time t on (key: banner, armies, armiesTitle, west, east, layout)
export interface PanelSnapshot {
  t: number;
  key: string;
  html: string;
}

export interface ReplayHeader {
  format: typeof REPLAY_FORMAT;
  version: number;
  app: string;
  savedAt: string;
  config: Omit<SimConfig, 'presetGrid'>;
  mapChoice: string;
  grid: string; // encodeGrid
  objective: {
    mode: SimConfig['objective'];
    timeLimit: number | null;
    points: { name: string; position: Position }[];
    bases: { faction: Faction; position: Position; maxHp: number }[];
  };
  units: ReplayUnit[];
  panels: PanelSnapshot[];
  result: unknown;
  frameCount: number;
}

export interface Replay {
  header: ReplayHeader;
  grid: TerrainType[][];
  frames: ReplayFrame[];
}

// --- Saving ---

export async function encodeReplay(replay: Replay): Promise<Blob> {
  const header: ReplayHeader = {
    ...replay.header,
    grid: encodeGrid(replay.grid),
    frameCount: replay.frames.length,
  };
  // Per frame: t (f64), n (u32), heroes and objective as JSON (length u32 + bytes), then the
  // columns: idx, dx, dy, hp (u16/i16), state, courage (u8)
  const parts: BlobPart[] = [];
  const enc = new TextEncoder();
  const headerBytes = enc.encode(JSON.stringify(header));
  parts.push(u32(headerBytes.length), bytes(headerBytes));
  const last = new Map<number, { x: number; y: number }>();
  for (const f of replay.frames) {
    const n = f.idx.length;
    const meta = enc.encode(JSON.stringify({ heroes: f.heroes, objective: f.objective }));
    const fixed = new DataView(new ArrayBuffer(16));
    fixed.setFloat64(0, f.t, true);
    fixed.setUint32(8, n, true);
    fixed.setUint32(12, meta.length, true);
    const dx = new Int16Array(n);
    const dy = new Int16Array(n);
    for (let k = 0; k < n; k++) {
      const prev = last.get(f.idx[k]);
      dx[k] = prev ? f.x[k] - prev.x : f.x[k];
      dy[k] = prev ? f.y[k] - prev.y : f.y[k];
      last.set(f.idx[k], { x: f.x[k], y: f.y[k] });
    }
    parts.push(
      fixed.buffer,
      bytes(meta),
      bytes(f.idx),
      bytes(dx),
      bytes(dy),
      bytes(f.hp),
      bytes(f.state),
      bytes(f.courage)
    );
  }
  const raw = new Blob(parts);
  return new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

// --- Loading ---

export async function decodeReplay(file: Blob): Promise<Replay> {
  let buffer: ArrayBuffer;
  try {
    buffer = await new Response(
      file.stream().pipeThrough(new DecompressionStream('gzip'))
    ).arrayBuffer();
  } catch {
    throw new Error('This file is not a replay (it could not be decompressed).');
  }
  const view = new DataView(buffer);
  const dec = new TextDecoder();
  let at = 0;
  const need = (n: number) => {
    if (at + n > buffer.byteLength) throw new Error('The replay file is cut short.');
  };
  need(4);
  const headerLen = view.getUint32(at, true);
  at += 4;
  need(headerLen);
  const header = JSON.parse(dec.decode(new Uint8Array(buffer, at, headerLen))) as ReplayHeader;
  at += headerLen;
  if (header.format !== REPLAY_FORMAT) throw new Error('This file is not a replay.');
  if (header.version > REPLAY_VERSION)
    throw new Error('This replay was saved by a newer version of the simulation.');
  const grid = decodeGrid(header.grid);
  if (!grid) throw new Error('The replay has no readable map.');

  const frames: ReplayFrame[] = [];
  const last = new Map<number, { x: number; y: number }>();
  for (let i = 0; i < header.frameCount; i++) {
    need(16);
    const t = view.getFloat64(at, true);
    const n = view.getUint32(at + 8, true);
    const metaLen = view.getUint32(at + 12, true);
    at += 16;
    need(metaLen + n * 10);
    const meta = JSON.parse(dec.decode(new Uint8Array(buffer, at, metaLen))) as Pick<
      ReplayFrame,
      'heroes' | 'objective'
    >;
    at += metaLen;
    // Copies: the columns are not aligned in the file
    const idx = new Uint16Array(buffer.slice(at, at + n * 2));
    at += n * 2;
    const x = new Int16Array(buffer.slice(at, at + n * 2));
    at += n * 2;
    const y = new Int16Array(buffer.slice(at, at + n * 2));
    at += n * 2;
    const hp = new Uint16Array(buffer.slice(at, at + n * 2));
    at += n * 2;
    const state = new Uint8Array(buffer.slice(at, at + n));
    at += n;
    const courage = new Uint8Array(buffer.slice(at, at + n));
    at += n;
    for (let k = 0; k < n; k++) {
      const prev = last.get(idx[k]);
      if (prev) {
        x[k] += prev.x;
        y[k] += prev.y;
      }
      last.set(idx[k], { x: x[k], y: y[k] });
    }
    frames.push({
      t,
      idx,
      x,
      y,
      hp,
      state,
      courage,
      heroes: meta.heroes,
      objective: meta.objective,
    });
  }
  header.panels = header.panels.map((p) => ({ ...p, html: sanitizeHtml(p.html) }));
  return { header, grid, frames };
}

// A replay file can come from anyone: its panel HTML is cleaned before it is shown (no scripts,
// no event handlers, no links or frames). The panels themselves only use plain markup.
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.body
    .querySelectorAll('script, style, iframe, object, embed, link, meta, form, a, img, svg')
    .forEach((el) => el.remove());
  doc.body.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const bad =
        /^on/i.test(attr.name) ||
        /^(href|src|srcset|action|formaction|xlink:href)$/i.test(attr.name) ||
        // inline styles stay (bar widths and colours) unless they load something
        (attr.name.toLowerCase() === 'style' && /url\(|expression|@import/i.test(attr.value));
      if (bad) el.removeAttribute(attr.name);
    }
  });
  return doc.body.innerHTML;
}

function u32(n: number): ArrayBuffer {
  const b = new DataView(new ArrayBuffer(4));
  b.setUint32(0, n, true);
  return b.buffer;
}

// The array's bytes as their own ArrayBuffer (a Blob part)
function bytes(a: Uint16Array | Int16Array | Uint8Array): ArrayBuffer {
  return a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) as ArrayBuffer;
}
