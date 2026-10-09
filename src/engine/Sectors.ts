import { Position, GRID_SIZE } from '../types/types';

// Sector grid used to describe locations to the AI layers (D17).
// 10×10 sectors of 15×15 tiles: columns A–J left to right, rows 1–10 top to bottom.

export const SECTORS_PER_SIDE = 10;
export const SECTOR_SIZE = GRID_SIZE / SECTORS_PER_SIDE;
const COLUMNS = 'ABCDEFGHIJ';

export function positionToSector(pos: Position): string {
  const col = Math.min(SECTORS_PER_SIDE - 1, Math.max(0, Math.floor(pos.x / SECTOR_SIZE)));
  const row = Math.min(SECTORS_PER_SIDE - 1, Math.max(0, Math.floor(pos.y / SECTOR_SIZE)));
  return `${COLUMNS[col]}${row + 1}`;
}

// Centre tile of a sector such as "D4". Returns null for an invalid name.
export function sectorCenter(sector: string): Position | null {
  const match = /^([A-J])(10|[1-9])$/.exec(sector.trim().toUpperCase());
  if (!match) return null;
  const col = COLUMNS.indexOf(match[1]);
  const row = Number(match[2]) - 1;
  return {
    x: Math.floor(col * SECTOR_SIZE + SECTOR_SIZE / 2),
    y: Math.floor(row * SECTOR_SIZE + SECTOR_SIZE / 2),
  };
}

// Each sector is split 3×3 into sub-sectors of 5×5 tiles, so orders can be more precise
// than a whole sector: "D4-NE" is the north-east corner of D4, "D4" or "D4-C" its centre.
export const SUBSECTORS = ['NW', 'N', 'NE', 'W', 'C', 'E', 'SW', 'S', 'SE'] as const;
const SUB_SIZE = SECTOR_SIZE / 3;

// Target tile for "D4" or "D4-NE". Returns null for an invalid name. The LLM writes these
// names, so spaces around the dash and typographic dashes ("D4 – NE") are read as "D4-NE";
// anything more ("D4-NE-X") is refused rather than guessed.
export function sectorTarget(name: string): Position | null {
  const parts = name
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .split('-');
  if (parts.length > 2) return null;
  const [sector, sub = 'C'] = parts.map((p) => p.trim());
  const centre = sectorCenter(sector);
  const index = SUBSECTORS.indexOf(sub as (typeof SUBSECTORS)[number]);
  if (!centre || index < 0) return null;
  const col = Math.floor(centre.x / SECTOR_SIZE);
  const row = Math.floor(centre.y / SECTOR_SIZE);
  return {
    x: Math.floor(col * SECTOR_SIZE + (index % 3) * SUB_SIZE + SUB_SIZE / 2),
    y: Math.floor(row * SECTOR_SIZE + Math.floor(index / 3) * SUB_SIZE + SUB_SIZE / 2),
  };
}

// "D4-NE" style name of the sub-sector containing a position.
export function positionToSubsector(pos: Position): string {
  const sx = Math.floor((((pos.x % SECTOR_SIZE) + SECTOR_SIZE) % SECTOR_SIZE) / SUB_SIZE);
  const sy = Math.floor((((pos.y % SECTOR_SIZE) + SECTOR_SIZE) % SECTOR_SIZE) / SUB_SIZE);
  return `${positionToSector(pos)}-${SUBSECTORS[Math.min(2, sy) * 3 + Math.min(2, sx)]}`;
}

export function allSectors(): string[] {
  const names: string[] = [];
  for (let r = 1; r <= SECTORS_PER_SIDE; r++) {
    for (const c of COLUMNS) names.push(`${c}${r}`);
  }
  return names;
}
