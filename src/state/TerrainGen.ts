import { TerrainType, GRID_SIZE, TerrainDensity } from '../types/types';

// Random terrain: forest, swamp and mountain grown as blobs on an open map, in that order.

export function generateTerrain(density: TerrainDensity = 'normal'): TerrainType[][] {
  const grid: TerrainType[][] = Array.from({ length: GRID_SIZE }, () =>
    new Array(GRID_SIZE).fill(TerrainType.OPEN)
  );

  const presets: Record<TerrainDensity, { forest: number; swamp: number; mountain: number }> = {
    light: { forest: 0.15, swamp: 0.08, mountain: 0.05 },
    normal: { forest: 0.25, swamp: 0.15, mountain: 0.1 },
    dense: { forest: 0.32, swamp: 0.2, mountain: 0.14 },
  };
  const p = presets[density] ?? presets.normal; // a config set from code may hold anything
  const totalTiles = GRID_SIZE * GRID_SIZE;
  placeBlobClusters(grid, TerrainType.FOREST, Math.floor(totalTiles * p.forest), 4, 12);
  placeBlobClusters(grid, TerrainType.SWAMP, Math.floor(totalTiles * p.swamp), 3, 8);
  placeBlobClusters(grid, TerrainType.MOUNTAIN, Math.floor(totalTiles * p.mountain), 2, 6);

  return grid;
}

function placeBlobClusters(
  grid: TerrainType[][],
  type: TerrainType,
  targetCount: number,
  minClusters: number,
  maxClusters: number
): void {
  const numClusters = minClusters + Math.floor(Math.random() * (maxClusters - minClusters + 1));
  const tilesPerCluster = Math.ceil(targetCount / numClusters);
  let totalPlaced = 0;

  for (let c = 0; c < numClusters && totalPlaced < targetCount; c++) {
    let sx = 0,
      sy = 0,
      found = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      sx = Math.floor(Math.random() * GRID_SIZE);
      sy = Math.floor(Math.random() * GRID_SIZE);
      if (grid[sy][sx] === TerrainType.OPEN) {
        found = true;
        break;
      }
    }
    if (!found) continue;

    const frontier: number[] = [sy * GRID_SIZE + sx];
    const inFrontier = new Set<number>(frontier);
    const clusterTarget = Math.min(tilesPerCluster, targetCount - totalPlaced);
    let clusterPlaced = 0;

    while (frontier.length > 0 && clusterPlaced < clusterTarget) {
      const idx = Math.floor(Math.random() * frontier.length);
      const key = frontier[idx];
      frontier[idx] = frontier[frontier.length - 1];
      frontier.pop();

      const x = key % GRID_SIZE;
      const y = Math.floor(key / GRID_SIZE);

      if (grid[y][x] !== TerrainType.OPEN) continue;

      grid[y][x] = type;
      totalPlaced++;
      clusterPlaced++;

      const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      for (const [dx, dy] of dirs) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
        const nk = ny * GRID_SIZE + nx;
        if (!inFrontier.has(nk) && grid[ny][nx] === TerrainType.OPEN) {
          inFrontier.add(nk);
          frontier.push(nk);
        }
      }
    }
  }
}
