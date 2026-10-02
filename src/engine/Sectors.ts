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

export function allSectors(): string[] {
  const names: string[] = [];
  for (let r = 1; r <= SECTORS_PER_SIDE; r++) {
    for (const c of COLUMNS) names.push(`${c}${r}`);
  }
  return names;
}
