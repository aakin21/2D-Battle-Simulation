import { TerrainType, GRID_SIZE } from '../types/types';

// Saved maps (D5). A map is stored as text: one row per line-group, each row as
// run-length pairs "<terrain><count>" separated by commas, rows separated by "/".
// Example row: "012,25,07" = 12 open, 5 forest, 7 open.

const LS_MAPS = 'sim_maps';
const VERSION = 'v1';

export function encodeGrid(grid: TerrainType[][]): string {
  const rows = grid.map((row) => {
    const runs: string[] = [];
    let current = row[0];
    let count = 0;
    for (const tile of row) {
      if (tile === current) {
        count++;
      } else {
        runs.push(`${current}${count}`);
        current = tile;
        count = 1;
      }
    }
    runs.push(`${current}${count}`);
    return runs.join(',');
  });
  return `${VERSION};${GRID_SIZE};${rows.join('/')}`;
}

export function decodeGrid(text: string): TerrainType[][] | null {
  const [version, size, body] = text.split(';');
  if (version !== VERSION || Number(size) !== GRID_SIZE || !body) return null;

  const rows = body.split('/');
  if (rows.length !== GRID_SIZE) return null;

  const grid: TerrainType[][] = [];
  for (const row of rows) {
    const tiles: TerrainType[] = [];
    for (const run of row.split(',')) {
      const tile = Number(run[0]) as TerrainType;
      const count = Number(run.slice(1));
      if (!(tile in TerrainType) || !Number.isInteger(count) || count <= 0) return null;
      for (let i = 0; i < count; i++) tiles.push(tile);
    }
    if (tiles.length !== GRID_SIZE) return null;
    grid.push(tiles);
  }
  return grid;
}

// Browser storage can be unavailable (private mode, blocked storage), so every
// access is guarded and falls back to "no saved maps".
function readAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LS_MAPS);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function listSavedMaps(): string[] {
  return Object.keys(readAll()).sort();
}

export function saveMap(name: string, grid: TerrainType[][]): boolean {
  try {
    const all = readAll();
    all[name] = encodeGrid(grid);
    localStorage.setItem(LS_MAPS, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export function loadSavedMap(name: string): TerrainType[][] | null {
  const text = readAll()[name];
  return text ? decodeGrid(text) : null;
}
