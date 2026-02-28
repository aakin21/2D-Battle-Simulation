import {
  TerrainType,
  UnitType,
  Faction,
  BehaviorState,
  IBattlefield,
  IUnit,
  IHero,
  Position,
  UNIT_STATS,
  GRID_SIZE,
} from '../types/types';

export class StateManager {
  private battlefield: IBattlefield;
  private nextId: number = 0;

  constructor() {
    this.battlefield = this.emptyBattlefield();
  }

  initGrid(): void {
    const grid: TerrainType[][] = Array.from({ length: GRID_SIZE }, () =>
      new Array(GRID_SIZE).fill(TerrainType.OPEN)
    );

    // Blob-based procedural generation — no gaps, irregular shapes
    // Target: 50% OPEN, 25% FOREST, 15% SWAMP, 10% MOUNTAIN
    const totalTiles = GRID_SIZE * GRID_SIZE;
    this.placeBlobClusters(grid, TerrainType.FOREST,   Math.floor(totalTiles * 0.25), 4, 12);
    this.placeBlobClusters(grid, TerrainType.SWAMP,    Math.floor(totalTiles * 0.15), 3,  8);
    this.placeBlobClusters(grid, TerrainType.MOUNTAIN, Math.floor(totalTiles * 0.10), 2,  6);

    this.battlefield.grid = grid;
  }

  private placeBlobClusters(
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
      // Find a random OPEN seed tile
      let sx = 0, sy = 0, found = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        sx = Math.floor(Math.random() * GRID_SIZE);
        sy = Math.floor(Math.random() * GRID_SIZE);
        if (grid[sy][sx] === TerrainType.OPEN) { found = true; break; }
      }
      if (!found) continue;

      // Grow blob from seed: pick random tile from frontier each step
      const frontier: number[] = [sy * GRID_SIZE + sx];
      const inFrontier = new Set<number>(frontier);
      const clusterTarget = Math.min(tilesPerCluster, targetCount - totalPlaced);
      let clusterPlaced = 0;

      while (frontier.length > 0 && clusterPlaced < clusterTarget) {
        // O(1) random removal: swap picked with last, then pop
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

        // Add 4-directional OPEN neighbors to frontier
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of dirs) {
          const nx = x + dx, ny = y + dy;
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

  spawnInitialUnits(): void {
    // Warriors: left half of the map
    const warriorPositions = this.getShuffledPositions(5, 60, 10, 140);
    for (let i = 0; i < 20; i++) {
      const unit = this.createUnit(UnitType.WARRIOR, Faction.FRIENDLY);
      unit.position = warriorPositions[i];
      this.battlefield.units.push(unit);
    }

    // Hero: center-left area
    const heroPositions = this.getShuffledPositions(10, 50, 60, 90);
    const hero = this.createHero();
    hero.position = heroPositions[0];
    this.battlefield.units.push(hero);

    this.battlefield.stats.totalSpawned = this.battlefield.units.length;
  }

  private createUnit(type: UnitType, faction: Faction): IUnit {
    const key = UnitType[type] as keyof typeof UNIT_STATS;
    const stats = UNIT_STATS[key];
    return {
      id:             `unit_${this.nextId++}`,
      position:       { x: 0, y: 0 },
      hp:             stats.hp,
      maxHp:          stats.hp,
      courage:        stats.courage,
      unitType:       type,
      faction,
      state:          BehaviorState.IDLE,
      sight:          stats.sight,
      baseSpeed:      stats.speed,
      damage:         stats.damage,
      path:           [],
      target:         null,
      attackCooldown: 0,
    };
  }

  private createHero(): IHero {
    const base = this.createUnit(UnitType.HERO, Faction.FRIENDLY);
    return {
      ...base,
      taskPoint:      null,
      charismaRadius: 10,
      charismaBonus:  20,
    };
  }

  // Fisher-Yates shuffle
  getShuffledPositions(
    xMin: number,
    xMax: number,
    yMin: number,
    yMax: number
  ): Position[] {
    const positions: Position[] = [];

    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        if (this.isClearTile(x, y)) {
          positions.push({ x, y });
        }
      }
    }

    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }

    return positions;
  }

  public isClearTile(x: number, y: number): boolean {
    const dirs = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    return dirs.every(([dx, dy]) =>
      this.battlefield.grid[y + dy]?.[x + dx] !== TerrainType.MOUNTAIN
    );
  }

  getUnitsInRadius(cx: number, cy: number, radius: number): IUnit[] {
    const r2 = radius * radius;
    return this.battlefield.units.filter(u => {
      const dx = u.position.x - cx;
      const dy = u.position.y - cy;
      return dx * dx + dy * dy <= r2;
    });
  }

  getHero(): IHero | undefined {
    return this.battlefield.units.find(u => u.unitType === UnitType.HERO) as IHero | undefined;
  }

  addUnit(unit: IUnit): void {
    this.battlefield.units.push(unit);
    this.battlefield.stats.totalSpawned++;
  }

  removeUnit(id: string): void {
    const units = this.battlefield.units;
    const idx = units.findIndex(u => u.id === id);
    if (idx === -1) return;
    // O(1) swap-and-pop instead of O(n) splice
    units[idx] = units[units.length - 1];
    units.pop();
    this.battlefield.stats.casualties++;
  }

  getBattlefield(): IBattlefield {
    return this.battlefield;
  }

  getUnitById(id: string): IUnit | undefined {
    return this.battlefield.units.find(u => u.id === id);
  }

  reset(): void {
    this.nextId = 0;
    this.battlefield = this.emptyBattlefield();
    this.initGrid();
    this.spawnInitialUnits();
  }

  private emptyBattlefield(): IBattlefield {
    return {
      grid:         [],
      units:        [],
      elapsedTime:  0,
      waveNumber:   0,
      nextWaveTime: 30,   // first wave at 30 simulation seconds
      stats:        { totalSpawned: 0, casualties: 0 },
    };
  }
}
