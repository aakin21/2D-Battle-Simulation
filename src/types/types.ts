export enum TerrainType {
  OPEN,
  FOREST,
  SWAMP,
  MOUNTAIN,
}

export enum UnitType {
  WARRIOR,
  HERO,
  BERSERKER,
}

export enum Faction {
  FRIENDLY,
  ENEMY,
}

export enum BehaviorState {
  IDLE,
  ATTACK,
  FLEE,
  REST,
}

export interface Position {
  x: number;
  y: number;
}

export interface IUnit {
  id: string;
  position: Position;
  hp: number;
  maxHp: number;
  courage: number;
  unitType: UnitType;
  faction: Faction;
  state: BehaviorState;
  sight: number;
  baseSpeed: number;
  damage: number;
  path: Position[]; // A* path to follow — empty when idle or in combat
  target: string | null; // ID of the unit being attacked (null = no target)
  attackCooldown: number; // seconds until next attack (0 = ready)
  groupId: string; // spawn group identifier — used for coordinated berserker patrol
}

export interface IHero extends IUnit {
  taskPoint: Position | null;
  charismaRadius: number;
  charismaBonus: number;
}

export interface IBattlefield {
  grid: TerrainType[][];
  units: IUnit[];
  elapsedTime: number;
  waveNumber: number;
  nextWaveTime: number; // simulation seconds at which the next wave spawns
  stats: {
    totalSpawned: number;
    casualties: number;
  };
}

// Rendering camera — shared between Renderer and MinimapRenderer
export interface Camera {
  x: number;
  y: number;
  zoom: number; // pixels per tile
}

export const UNIT_STATS = {
  WARRIOR: { hp: 110, courage: 70, sight: 10, speed: 2.0, damage: 20 },
  HERO: { hp: 200, courage: 100, sight: 15, speed: 3.0, damage: 40 },
  BERSERKER: { hp: 80, courage: 100, sight: 12, speed: 2.5, damage: 25 },
};

export const TERRAIN_SPEED: Record<string, number> = {
  OPEN: 1.0,
  FOREST: 0.7,
  SWAMP: 0.5,
  MOUNTAIN: 0,
};

export const TERRAIN_SIGHT: Record<string, number> = {
  OPEN: 1.0,
  FOREST: 0.5,
  SWAMP: 0.4,
  MOUNTAIN: 0,
};

export const TERRAIN_COLORS: Record<string, string> = {
  OPEN: '#90EE90',
  FOREST: '#228B22',
  SWAMP: '#8FBC8F',
  MOUNTAIN: '#808080',
};

export const UNIT_COLORS: Record<string, string> = {
  WARRIOR: '#FFD700',
  HERO: '#FF0000',
  BERSERKER: '#4169E1',
};

export const GRID_SIZE = 150;
export const TILE_SIZE = 5; // pixels per tile at base zoom (offscreen terrain canvas = 750×750)

export type TerrainDensity = 'light' | 'normal' | 'dense';

export interface SimConfig {
  warriorCount: number;
  waveMultiplier: number;
  terrainDensity: TerrainDensity;
}

export const DEFAULT_CONFIG: SimConfig = {
  warriorCount: 300,
  waveMultiplier: 1,
  terrainDensity: 'normal',
};
