import {
  TerrainType,
  UnitType,
  Faction,
  BehaviorState,
  IBattlefield,
  IUnit,
  IHero,
  HeroController,
  Objective,
  Position,
  UNIT_STATS,
  GRID_SIZE,
  SimConfig,
  TerrainDensity,
  DEFAULT_CONFIG,
} from '../types/types';
import { Pathfinder } from '../engine/Pathfinder';
import { SpatialGrid } from '../engine/SpatialGrid';
import { BerserkerPool } from '../engine/BerserkerPool';
import {
  CHARISMA_RADIUS,
  CHARISMA_BONUS,
  CONTROL_TIME_LIMIT,
  MATCH_TIME_LIMIT,
  BASE_HP,
} from '../engine/Rules';

// Battle mode: soldiers start at random tiles within this many columns of their side's
// hero column (west x = 20, east x = 129), over the full height of the map.
const SPAWN_AREA_HALF_WIDTH = 20;

export class StateManager {
  private battlefield: IBattlefield;
  private nextId: number = 0;
  private stressMode: boolean = false;
  private spatialGrid = new SpatialGrid();
  private berserkerPool = new BerserkerPool();
  private unitMap = new Map<string, IUnit>();
  private heroRef: IHero | undefined;
  private heroes: IHero[] = [];
  private battleMode: boolean = false;
  private mainRegion = new Uint8Array(GRID_SIZE * GRID_SIZE);

  setStressMode(on: boolean): void {
    this.stressMode = on;
  }

  constructor() {
    this.battlefield = this.emptyBattlefield();
  }

  initGrid(density: TerrainDensity = 'normal'): void {
    const grid: TerrainType[][] = Array.from({ length: GRID_SIZE }, () =>
      new Array(GRID_SIZE).fill(TerrainType.OPEN)
    );

    const presets: Record<TerrainDensity, { forest: number; swamp: number; mountain: number }> = {
      light: { forest: 0.15, swamp: 0.08, mountain: 0.05 },
      normal: { forest: 0.25, swamp: 0.15, mountain: 0.1 },
      dense: { forest: 0.32, swamp: 0.2, mountain: 0.14 },
    };
    const p = presets[density];
    const totalTiles = GRID_SIZE * GRID_SIZE;
    this.placeBlobClusters(grid, TerrainType.FOREST, Math.floor(totalTiles * p.forest), 4, 12);
    this.placeBlobClusters(grid, TerrainType.SWAMP, Math.floor(totalTiles * p.swamp), 3, 8);
    this.placeBlobClusters(grid, TerrainType.MOUNTAIN, Math.floor(totalTiles * p.mountain), 2, 6);

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

  spawnInitialUnits(warriorCount: number = 100): void {
    const warriorPositions = this.getShuffledPositions(5, 74, 5, 145);
    const count = Math.min(warriorCount, warriorPositions.length);
    for (let i = 0; i < count; i++) {
      const unit = this.createUnit(UnitType.WARRIOR, Faction.FRIENDLY);
      unit.position = warriorPositions[i];
      this.addUnit(unit);
    }

    const heroPositions = this.getShuffledPositions(10, 50, 60, 90);
    const hero = this.createHero();
    hero.position = heroPositions[0];
    hero.home = { x: heroPositions[0].x, y: heroPositions[0].y };
    this.addUnit(hero);

    if (this.stressMode) {
      const extraWarriorPositions = this.getShuffledPositions(5, 60, 10, 140);
      for (let i = 0; i < 1900 && i < extraWarriorPositions.length; i++) {
        const unit = this.createUnit(UnitType.WARRIOR, Faction.FRIENDLY);
        unit.position = extraWarriorPositions[i];
        this.addUnit(unit);
      }
    }

    if (this.stressMode) {
      const berserkerPositions = this.getShuffledPositions(90, 145, 10, 140);
      const rallyPoint: Position = { x: 30, y: 75 };
      for (let i = 0; i < 2000 && i < berserkerPositions.length; i++) {
        const unit = this.createUnit(UnitType.BERSERKER, Faction.ENEMY);
        unit.position = berserkerPositions[i];
        unit.groupId = 'stress_all';
        unit.path = Pathfinder.findPath(this.battlefield.grid, berserkerPositions[i], rallyPoint);
        this.addUnit(unit);
      }
    }
  }

  private createUnit(
    type: UnitType,
    faction: Faction,
    stats = UNIT_STATS[UnitType[type] as keyof typeof UNIT_STATS]
  ): IUnit {
    return {
      id: `unit_${this.nextId++}`,
      position: { x: 0, y: 0 },
      hp: stats.hp,
      maxHp: stats.hp,
      courage: stats.courage,
      unitType: type,
      faction,
      state: BehaviorState.IDLE,
      sight: stats.sight,
      baseSpeed: stats.speed,
      damage: stats.damage,
      path: [],
      target: null,
      attackCooldown: 0,
      groupId: '',
    };
  }

  private createHero(
    faction: Faction = Faction.FRIENDLY,
    controller: HeroController = 'user',
    heroIndex = 1
  ): IHero {
    const base = this.createUnit(UnitType.HERO, faction);
    return {
      ...base,
      taskPoint: null,
      charismaRadius: CHARISMA_RADIUS,
      charismaBonus: CHARISMA_BONUS,
      controller,
      heroIndex,
      home: { x: 0, y: 0 },
      command: null,
      commandSource: null,
      commandTime: 0,
      lastLlmCommand: null,
      lastLlmTime: 0,
      disengaging: false,
      reflexOverridden: false,
    };
  }

  // Battle mode: both sides get the same structure. Heroes are spread along each side's
  // edge, and each hero starts with its share of soldiers around it so they follow it.
  // Friendly soldiers are warriors, enemy soldiers are berserkers; both use warrior stats.
  private spawnBattleUnits(config: SimConfig): void {
    const heroCount = Math.max(1, config.heroesPerSide);
    const perHero = Math.floor(config.warriorCount / heroCount);
    const sides: Array<{
      faction: Faction;
      type: UnitType;
      x: number;
      controller: HeroController;
    }> = [
      {
        faction: Faction.FRIENDLY,
        type: UnitType.WARRIOR,
        x: 20,
        controller: (config.friendlyAI ?? 'none') === 'none' ? 'user' : 'ai',
      },
      {
        faction: Faction.ENEMY,
        type: UnitType.BERSERKER,
        x: 129,
        controller: (config.enemyAI ?? 'none') === 'none' ? 'rule' : 'ai',
      },
    ];

    for (const side of sides) {
      const heroTiles = new Set<string>();
      for (let h = 0; h < heroCount; h++) {
        const cy = Math.round(((h + 1) * GRID_SIZE) / (heroCount + 1));
        const heroPos = this.clearSpotsAround(side.x, cy, 3, 1, 40)[0];
        if (!heroPos) continue;

        const hero = this.createHero(side.faction, side.controller, h + 1);
        hero.baseSpeed = UNIT_STATS.WARRIOR.speed; // D18: hero moves at its group's speed
        // Tile centres, matching how the pathfinder plans moves (corners can clip mountains).
        hero.position = { x: heroPos.x + 0.5, y: heroPos.y + 0.5 };
        hero.home = { x: heroPos.x, y: heroPos.y };
        this.addUnit(hero);
        heroTiles.add(`${heroPos.x},${heroPos.y}`);
      }

      // Soldiers start at random tiles in their side's area, not around a hero: heroes have
      // to collect the ones out of their sight first.
      const spots = this.getShuffledPositions(
        Math.max(1, side.x - SPAWN_AREA_HALF_WIDTH),
        Math.min(GRID_SIZE - 1, side.x + SPAWN_AREA_HALF_WIDTH + 1),
        1,
        GRID_SIZE - 1
      ).filter((p) => this.isInMainRegion(p.x, p.y) && !heroTiles.has(`${p.x},${p.y}`));
      const soldiers = perHero * heroCount;
      for (let i = 0; i < soldiers && i < spots.length; i++) {
        const unit = this.createUnit(side.type, side.faction, UNIT_STATS.WARRIOR);
        unit.position = { x: spots[i].x + 0.5, y: spots[i].y + 0.5 };
        this.addUnit(unit);
      }
    }
  }

  // Shuffled clear tiles of the main region in a square around (cx, cy). The square grows
  // until it holds at least `needed` tiles. Soldiers keep the default limit so they start
  // within their hero's sight.
  private clearSpotsAround(
    cx: number,
    cy: number,
    radius: number,
    needed: number,
    maxRadius = 12
  ): Position[] {
    let spots: Position[] = [];
    for (let r = radius; r <= maxRadius; r += 2) {
      spots = this.getShuffledPositions(
        Math.max(1, cx - r),
        Math.min(GRID_SIZE - 1, cx + r + 1),
        Math.max(1, cy - r),
        Math.min(GRID_SIZE - 1, cy + r + 1)
      ).filter((p) => this.isInMainRegion(p.x, p.y));
      if (spots.length >= needed) break;
    }
    return spots;
  }

  getShuffledPositions(xMin: number, xMax: number, yMin: number, yMax: number): Position[] {
    const positions: Position[] = [];

    for (let y = yMin; y < yMax; y++) {
      for (let x = xMin; x < xMax; x++) {
        if (this.isClearTile(x, y)) positions.push({ x, y });
      }
    }

    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }

    return positions;
  }

  public isClearTile(x: number, y: number): boolean {
    const dirs = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    return dirs.every(
      ([dx, dy]) => this.battlefield.grid[y + dy]?.[x + dx] !== TerrainType.MOUNTAIN
    );
  }

  // True if the tile belongs to the largest connected walkable area of the map.
  // Mountains can enclose small pockets; a unit inside one can never reach the rest.
  public isInMainRegion(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= GRID_SIZE || ty >= GRID_SIZE) return false;
    return this.mainRegion[ty * GRID_SIZE + tx] === 1;
  }

  // Flood-fills walkable tiles (same rule as the pathfinder) and keeps the largest area.
  private computeMainRegion(): void {
    const label = new Int32Array(GRID_SIZE * GRID_SIZE).fill(-1);
    let best = -1;
    let bestSize = 0;
    let next = 0;
    const stack: number[] = [];

    for (let start = 0; start < label.length; start++) {
      if (label[start] !== -1) continue;
      const sx = start % GRID_SIZE;
      const sy = Math.floor(start / GRID_SIZE);
      if (!this.isClearTile(sx, sy)) continue;

      const id = next++;
      let size = 0;
      label[start] = id;
      stack.push(start);
      while (stack.length > 0) {
        const k = stack.pop()!;
        size++;
        const x = k % GRID_SIZE;
        const y = Math.floor(k / GRID_SIZE);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_SIZE || ny >= GRID_SIZE) continue;
          const nk = ny * GRID_SIZE + nx;
          if (label[nk] !== -1 || !this.isClearTile(nx, ny)) continue;
          label[nk] = id;
          stack.push(nk);
        }
      }
      if (size > bestSize) {
        bestSize = size;
        best = id;
      }
    }

    this.mainRegion = new Uint8Array(label.length);
    for (let k = 0; k < label.length; k++) if (label[k] === best) this.mainRegion[k] = 1;
  }

  // Hot path: no array allocation — calls cb for each unit within radius.
  forEachInRadius(cx: number, cy: number, radius: number, cb: (unit: IUnit) => void): void {
    this.spatialGrid.forEach(cx, cy, radius, cb);
  }

  // Living units within radius per faction, into out[faction] (courage; D31)
  countByFactionInRadius(cx: number, cy: number, radius: number, out: Int32Array): void {
    this.spatialGrid.countByFaction(cx, cy, radius, out);
  }

  // Nearest living unit not of `faction` within radius (D31). When several share the
  // minimum distance, wasNearestTied() is true and the caller resolves it.
  nearestEnemyInRadius(cx: number, cy: number, radius: number, faction: number): IUnit | null {
    return this.spatialGrid.nearestEnemy(cx, cy, radius, faction);
  }

  wasNearestTied(): boolean {
    return this.spatialGrid.wasNearestTied();
  }

  // Returns array — used by UIController for click selection and hover tooltip.
  getUnitsInRadius(cx: number, cy: number, radius: number): IUnit[] {
    return this.spatialGrid.query(cx, cy, radius);
  }

  // Called by SimulationEngine after moving a unit to keep the grid in sync.
  syncPosition(unit: IUnit, oldX: number, oldY: number): void {
    this.spatialGrid.move(unit, { x: oldX, y: oldY });
  }

  // First friendly hero. In classic mode this is the only hero.
  getHero(): IHero | undefined {
    return this.heroRef;
  }

  getHeroes(): IHero[] {
    return this.heroes;
  }

  isBattleMode(): boolean {
    return this.battleMode;
  }

  spawnBerserker(x: number, y: number, groupId: string, initialPath: Position[] = []): void {
    const id = `unit_${this.nextId++}`;
    const unit = this.berserkerPool.acquire(id, x, y, groupId, initialPath);
    this.addUnit(unit);
  }

  addUnit(unit: IUnit): void {
    this.battlefield.units.push(unit);
    this.spatialGrid.insert(unit);
    this.unitMap.set(unit.id, unit);
    if (unit.unitType === UnitType.HERO) {
      this.heroes.push(unit as IHero);
      if (!this.heroRef && unit.faction === Faction.FRIENDLY) this.heroRef = unit as IHero;
    }
    this.battlefield.stats.totalSpawned++;
  }

  removeUnit(id: string): void {
    const units = this.battlefield.units;
    const idx = units.findIndex((u) => u.id === id);
    if (idx === -1) return;
    const unit = units[idx];
    units[idx] = units[units.length - 1];
    units.pop();
    this.battlefield.stats.casualties++;
    this.spatialGrid.remove(unit);
    this.unitMap.delete(id);
    if (unit.unitType === UnitType.HERO) {
      this.heroes = this.heroes.filter((h) => h.id !== id);
      if (this.heroRef?.id === id) {
        this.heroRef = this.heroes.find((h) => h.faction === Faction.FRIENDLY);
      }
    }
    // Battle-mode berserkers use warrior stats, so they must not go back into the pool.
    if (unit.unitType === UnitType.BERSERKER && !this.battleMode) this.berserkerPool.release(unit);
  }

  getBattlefield(): IBattlefield {
    return this.battlefield;
  }

  getUnitById(id: string): IUnit | undefined {
    return this.unitMap.get(id);
  }

  reset(config: SimConfig = DEFAULT_CONFIG): void {
    this.nextId = 0;
    this.battlefield = this.emptyBattlefield();
    this.spatialGrid.clear();
    this.berserkerPool.reset();
    this.unitMap.clear();
    this.heroRef = undefined;
    this.heroes = [];
    this.battleMode = config.mode === 'battle' && !this.stressMode;
    if (config.presetGrid) this.battlefield.grid = config.presetGrid.map((row) => row.slice());
    else this.initGrid(config.terrainDensity);
    this.computeMainRegion();
    if (this.battleMode) {
      this.setupObjective(config.objective ?? 'elimination');
      this.spawnBattleUnits(config);
    } else this.spawnInitialUnits(config.warriorCount);
  }

  private emptyBattlefield(): IBattlefield {
    return {
      grid: [],
      units: [],
      elapsedTime: 0,
      waveNumber: 0,
      nextWaveTime: 30,
      stats: { totalSpawned: 0, casualties: 0 },
      objective: {
        mode: 'elimination',
        points: [],
        scores: { friendly: 0, enemy: 0 },
        timeLimit: null,
        bases: [],
      },
    };
  }

  // D30: control points A (north) and B (south) on the centre line, or one base per side at
  // its start area. Placed on the nearest tile of the main walkable region.
  private setupObjective(mode: Objective): void {
    const o = this.battlefield.objective;
    o.mode = mode;
    o.timeLimit = mode === 'control' ? CONTROL_TIME_LIMIT : MATCH_TIME_LIMIT;
    if (mode === 'control') {
      o.points = [
        { name: 'A', position: this.nearestMainTile(75, 45), holder: null },
        { name: 'B', position: this.nearestMainTile(75, 105), holder: null },
      ];
    } else if (mode === 'base') {
      o.bases = [
        {
          faction: Faction.FRIENDLY,
          position: this.nearestMainTile(14, 75),
          hp: BASE_HP,
          maxHp: BASE_HP,
        },
        {
          faction: Faction.ENEMY,
          position: this.nearestMainTile(135, 75),
          hp: BASE_HP,
          maxHp: BASE_HP,
        },
      ];
    }
  }

  private nearestMainTile(x: number, y: number): Position {
    for (let r = 0; r < GRID_SIZE; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.isInMainRegion(x + dx, y + dy)) return { x: x + dx, y: y + dy };
        }
      }
    }
    return { x, y };
  }
}
