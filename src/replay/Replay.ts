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

interface ReplayHero {
  i: number; // index in `units`
  taskPoint: Position | null;
  command: HeroCommand | null;
  commandTime: number; // the marker's "new order" ring is drawn when this changes
}

interface ReplayObjective {
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

// The page elements whose HTML a replay keeps, by key (`layout`, which AI columns are shown, is
// kept as JSON)
export const PANEL_SELECTORS: Record<string, string> = {
  banner: '#match-banner',
  armies: '#armies-body',
  armiesTitle: '#armies-title',
  west: '#ai-col-west .ai-col-main',
  east: '#ai-col-east .ai-col-main',
};

// A key of PANEL_SELECTORS or `layout` (own keys only: never a name like "constructor")
export function isPanelKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    (key === 'layout' || Object.prototype.hasOwnProperty.call(PANEL_SELECTORS, key))
  );
}

// A side panel's HTML from time t on (key: banner, armies, armiesTitle, west, east, layout)
export interface PanelSnapshot {
  t: number;
  key: string;
  html: string;
}

interface ReplayHeader {
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
  // Each unit's place in the frame before (positions are written as changes since then)
  let units = replay.header.units.length;
  for (const f of replay.frames) for (const i of f.idx) units = Math.max(units, i + 1);
  const lastX = new Int16Array(units);
  const lastY = new Int16Array(units);
  const seen = new Uint8Array(units);
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
      const i = f.idx[k];
      dx[k] = seen[i] ? f.x[k] - lastX[i] : f.x[k];
      dy[k] = seen[i] ? f.y[k] - lastY[i] : f.y[k];
      seen[i] = 1;
      lastX[i] = f.x[k];
      lastY[i] = f.y[k];
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
  const buffer = await decompress(file);
  const view = new DataView(buffer);
  let at = 0;
  const need = (n: number) => {
    if (at + n > buffer.byteLength) throw new Error('The replay file is cut short.');
  };
  need(4);
  const headerLen = view.getUint32(at, true);
  at += 4;
  need(headerLen);
  const header = parseJson(new Uint8Array(buffer, at, headerLen)) as ReplayHeader;
  at += headerLen;
  if (typeof header !== 'object' || header === null || header.format !== REPLAY_FORMAT)
    throw new Error('This file is not a replay.');
  if (typeof header.version === 'number' && header.version > REPLAY_VERSION)
    throw new Error('This replay was saved by a newer version of the simulation.');
  if (!Number.isInteger(header.version) || header.version < 1) throw new Error(DAMAGED);
  const grid = typeof header.grid === 'string' ? decodeGrid(header.grid) : null;
  if (!grid) throw new Error('The replay has no readable map.');
  if (!validHeader(header)) throw new Error(DAMAGED);

  const frames: ReplayFrame[] = [];
  const units = header.units.length;
  const lastX = new Int16Array(units);
  const lastY = new Int16Array(units);
  const seen = new Uint8Array(units);
  let lastT = -Infinity;
  for (let i = 0; i < header.frameCount; i++) {
    need(16);
    const t = view.getFloat64(at, true);
    // Frame times are in order (the player searches them) and within a match's length
    if (!(t >= 0 && t <= MAX_REPLAY_SECONDS) || t < lastT) throw new Error(DAMAGED);
    lastT = t;
    const n = view.getUint32(at + 8, true);
    const metaLen = view.getUint32(at + 12, true);
    at += 16;
    need(metaLen + n * 10);
    const meta = parseJson(new Uint8Array(buffer, at, metaLen)) as Pick<
      ReplayFrame,
      'heroes' | 'objective'
    >;
    if (!validFrameMeta(meta, units)) throw new Error(DAMAGED);
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
      const u = idx[k];
      if (u >= units) throw new Error(DAMAGED);
      if (seen[u]) {
        x[k] += lastX[u];
        y[k] += lastY[u];
      }
      seen[u] = 1;
      lastX[u] = x[k];
      lastY[u] = y[k];
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

const DAMAGED = 'The replay file is damaged.';
// Frame times: a match lasts minutes (CONTROL_TIME_LIMIT, MATCH_TIME_LIMIT); more than a day is
// not a recording
const MAX_REPLAY_SECONDS = 24 * 60 * 60;
// Panel snapshots: a real panel is a few KB and a long match has some tens of thousands of
// snapshots. They are checked before any is parsed (a small file could otherwise make the
// sanitizer parse gigabytes, or markup that keeps the browser busy for minutes)
const MAX_PANEL_HTML = 64 * 1024;
const MAX_PANEL_SNAPSHOTS = 100_000;
// A replay of a long match is a few MB; a file that unpacks to more is refused while it is read
// (a small gzip file can unpack to gigabytes)
const MAX_REPLAY_BYTES = 200 * 1024 * 1024;

async function decompress(file: Blob): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPLAY_BYTES) {
        void reader.cancel();
        throw new Error('too large');
      }
      chunks.push(value);
    }
  } catch {
    if (size > MAX_REPLAY_BYTES)
      throw new Error('This replay is too large to open (over 200 MB unpacked).');
    throw new Error('This file is not a replay (it could not be decompressed).');
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all.buffer;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(DAMAGED);
  }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPosition = (p: unknown): p is Position =>
  typeof p === 'object' &&
  p !== null &&
  isFiniteNumber((p as Position).x) &&
  isFiniteNumber((p as Position).y);
const isFaction = (f: unknown) => f === Faction.FRIENDLY || f === Faction.ENEMY;
const isUnitType = (t: unknown) =>
  t === UnitType.WARRIOR || t === UnitType.HERO || t === UnitType.BERSERKER;

function validUnit(u: ReplayUnit, units: number): boolean {
  return (
    typeof u === 'object' &&
    u !== null &&
    typeof u.id === 'string' &&
    isUnitType(u.type) &&
    isFaction(u.faction) &&
    isFiniteNumber(u.maxHp) &&
    u.maxHp > 0 &&
    isFiniteNumber(u.sight) &&
    u.sight >= 0 &&
    (u.charismaRadius === undefined ||
      (isFiniteNumber(u.charismaRadius) && u.charismaRadius >= 0)) &&
    (u.heroIndex === undefined ||
      (Number.isInteger(u.heroIndex) && u.heroIndex >= 0 && u.heroIndex <= units))
  );
}

// A replay file can come from anyone: the lists and indexes the player reads are checked, so a
// damaged or edited file is refused instead of breaking the view
function validHeader(h: ReplayHeader): boolean {
  const o = h.objective;
  return (
    Array.isArray(h.units) &&
    h.units.every((u) => validUnit(u, h.units.length)) &&
    Array.isArray(h.panels) &&
    h.panels.length <= MAX_PANEL_SNAPSHOTS &&
    h.panels.every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        isFiniteNumber(p.t) &&
        isPanelKey(p.key) &&
        typeof p.html === 'string' &&
        p.html.length <= MAX_PANEL_HTML
    ) &&
    Number.isInteger(h.frameCount) &&
    h.frameCount >= 0 &&
    typeof o === 'object' &&
    o !== null &&
    (o.mode === undefined ||
      o.mode === 'elimination' ||
      o.mode === 'control' ||
      o.mode === 'base') &&
    (o.timeLimit === null ||
      o.timeLimit === undefined ||
      (isFiniteNumber(o.timeLimit) && o.timeLimit >= 0)) &&
    Array.isArray(o.points) &&
    o.points.every(
      (p) =>
        typeof p === 'object' && p !== null && typeof p.name === 'string' && isPosition(p.position)
    ) &&
    Array.isArray(o.bases) &&
    o.bases.every(
      (b) =>
        typeof b === 'object' &&
        b !== null &&
        isFaction(b.faction) &&
        isPosition(b.position) &&
        isFiniteNumber(b.maxHp) &&
        b.maxHp > 0
    )
  );
}

function validFrameMeta(m: Pick<ReplayFrame, 'heroes' | 'objective'>, units: number): boolean {
  const o = m?.objective;
  return (
    typeof m === 'object' &&
    m !== null &&
    Array.isArray(m.heroes) &&
    m.heroes.every(
      (h) =>
        typeof h === 'object' &&
        h !== null &&
        Number.isInteger(h.i) &&
        h.i >= 0 &&
        h.i < units &&
        (h.taskPoint === null || isPosition(h.taskPoint)) &&
        (h.command === null ||
          (typeof h.command === 'object' && typeof h.command.type === 'string')) &&
        isFiniteNumber(h.commandTime)
    ) &&
    typeof o === 'object' &&
    o !== null &&
    Array.isArray(o.holders) &&
    o.holders.every((f) => f === null || isFaction(f)) &&
    Array.isArray(o.baseHp) &&
    o.baseHp.every(isFiniteNumber) &&
    typeof o.scores === 'object' &&
    o.scores !== null &&
    isFiniteNumber(o.scores.friendly) &&
    isFiniteNumber(o.scores.enemy)
  );
}

// A replay file can come from anyone: its panel HTML is rebuilt from an allowlist before it is
// shown. The panels (Hud, AiPanel) use only plain markup: these elements, with their own classes,
// titles, data-* and inline bar widths and colours. Everything else is dropped with its content (scripts,
// links, images, media, frames, forms, SVG and MathML, and the raw-text elements such as noscript,
// xmp or noembed, whose content a page reads differently than the parser here: mXSS). The tree is
// built anew in an inert template, so what is serialized is only what was allowed.
const ALLOWED_TAGS = new Set([
  'div',
  'span',
  'i',
  'b',
  'em',
  'strong',
  'small',
  'br',
  'h2',
  'h3',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
const ALLOWED_ATTRS = new Set(['title', 'hidden', 'aria-hidden', 'colspan', 'rowspan']);
// The class names the panels use (Hud: banner and armies; AiPanel: the AI columns). Any other
// class is dropped: a page class such as `overlay` would let a replay cover the page.
const ALLOWED_CLASSES = new Set([
  // Hud
  'banner',
  'well',
  'side',
  'side-name',
  'side-val',
  'mid',
  'clock',
  'low',
  'flag',
  'base-bar',
  'bar',
  'west',
  'east',
  'west-text',
  'east-text',
  'army',
  'army-head',
  'army-who',
  'army-row',
  'hero-row',
  'hero-state',
  'lbl',
  'val',
  'dead',
  'faint',
  // AiPanel
  'ai-head',
  'ai-side-name',
  'ai-status',
  'ai-k',
  'ai-kv',
  'ai-busy',
  'ai-fail',
  'ai-warn',
  'ai-strategy',
  'stance',
  'stance-aggressive',
  'stance-defensive',
  'stance-regroup',
  'ai-plan',
  'ai-situation',
  'ai-why',
  'ai-clamp',
  'ai-more',
  'ai-hero',
  'ai-hero-head',
  'ai-hero-name',
  'override',
  'ai-src',
  'ai-src-llm',
  'ai-src-jev',
  'ai-src-rule',
  'ai-src-user',
  'ai-agree',
  'ai-override',
  'ai-meta',
]);
// Elements nested deeper than this are dropped with their content (the panels nest a few levels)
const MAX_DEPTH = 32;
// Inline styles: these properties, with plain values (numbers, units, names, colours, var())
const STYLE_PROPS = new Set([
  'width',
  'height',
  'background',
  'background-color',
  'color',
  'opacity',
]);
const STYLE_VALUE_MAX = 200;
const STYLE_VALUE = /^[\w\s.,#%-]*(?:(?:rgba?|hsla?|var)\([\w\s.,#%-]*\)[\w\s.,#%-]*)*$/i;

export function sanitizeHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = document.createElement('template').content;
  const copy = (from: Node, to: Node, depth: number) => {
    for (const node of Array.from(from.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        to.appendChild(out.ownerDocument.createTextNode(node.textContent ?? ''));
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue; // comments and the rest
      const el = node as Element;
      // Only HTML elements (no SVG or MathML namespace) of the allowed kinds
      if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      const tag = el.localName;
      if (!ALLOWED_TAGS.has(tag) || depth >= MAX_DEPTH) continue;
      const clean = out.ownerDocument.createElement(tag);
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (ALLOWED_ATTRS.has(name) || /^data-[a-z0-9-]+$/.test(name)) {
          clean.setAttribute(name, attr.value);
        } else if (name === 'class') {
          // Kept as written when every name is allowed (Hud writes "bar " for a plain bar)
          const names = attr.value.split(/\s+/).filter(Boolean);
          const kept = names.filter((c) => ALLOWED_CLASSES.has(c));
          if (kept.length === names.length) clean.setAttribute('class', attr.value);
          else if (kept.length) clean.setAttribute('class', kept.join(' '));
        } else if (name === 'style') {
          const style = cleanStyle(attr.value);
          if (style) clean.setAttribute('style', style);
        }
      }
      copy(el, clean, depth + 1);
      to.appendChild(clean);
    }
  };
  copy(parsed.body, out, 0);
  const host = out.ownerDocument.createElement('div');
  host.appendChild(out);
  return host.innerHTML;
}

// The declarations of an inline style that are allowed (property and value), or ''
function cleanStyle(style: string): string {
  const kept: string[] = [];
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (
      STYLE_PROPS.has(prop) &&
      value &&
      value.length <= STYLE_VALUE_MAX &&
      STYLE_VALUE.test(value)
    )
      kept.push(`${prop}:${value}`);
  }
  return kept.join(';');
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
