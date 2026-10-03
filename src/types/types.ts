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

// Who gives a hero its orders. 'rule' heroes patrol and charge on their own (no AI);
// 'ai' heroes get orders from the AI layers attached to the match (Jev and/or the LLM).
export type HeroController = 'user' | 'rule' | 'ai';

// Which AI layers command a side in battle mode. Every combination is offered so the
// layers can be compared on their own and together. 'none': the user (west) or the rule
// layer (east) commands the heroes.
export type SideAI = 'none' | 'jev' | 'llm' | 'jev+llm';

// D4: 'realtime' keeps the battle running and applies AI answers when they arrive;
// 'paused' freezes the battle until every pending AI answer has arrived.
export type AITiming = 'realtime' | 'paused';

// D29: which Claude model plays the LLM layer of a side (aliases understood by the Agent SDK).
export type LlmModel = 'haiku' | 'sonnet' | 'opus';

// Orders a hero can receive (D20). Every source (user, rule, Jev, LLM) uses the same set.
export type HeroCommand =
  | { type: 'move'; target: Position } // AI gives a sector, the user an exact point
  | { type: 'hold'; at: Position }
  | { type: 'retreat' }
  | { type: 'attack' }
  | { type: 'attackHero'; heroIndex: number }
  | { type: 'regroup' } // walk to the nearest group of stray soldiers of the hero's side (D28)
  | { type: 'continueLlm' }; // Jev only: keep following the LLM's latest command

export type CommandSource = 'user' | 'rule' | 'jev' | 'llm';

export interface IHero extends IUnit {
  taskPoint: Position | null; // where the hero is heading; derived from `command` each frame
  charismaRadius: number;
  charismaBonus: number;
  controller: HeroController;
  heroIndex: number; // 1-based number within its side, used by "attack hero N"
  home: Position; // start position; "retreat" falls back toward it
  command: HeroCommand | null;
  commandSource: CommandSource | null;
  commandTime: number; // simulation time of the last command
  lastLlmCommand: HeroCommand | null; // kept so Jev can see and resume the LLM's plan (D15)
  lastLlmTime: number; // simulation time of the LLM's latest command
  disengaging: boolean; // breaking off a fight: ignores enemies until clear of them (D27)
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
  FOREST: 0.8,
  SWAMP: 0.7,
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

// 'classic': Phase 1 game (one hero vs berserker waves).
// 'battle': symmetric sides, each with several heroes and soldiers that use courage.
export type GameMode = 'classic' | 'battle';

export interface SimConfig {
  mode: GameMode;
  warriorCount: number; // classic: friendly warriors; battle: soldiers per side
  waveMultiplier: number;
  terrainDensity: TerrainDensity;
  heroesPerSide: number; // battle only
  presetGrid?: TerrainType[][]; // fixed or saved map; a new random map is made when absent
  friendlyAI?: SideAI; // battle only: AI layers for the west side (default 'none' = the user)
  enemyAI?: SideAI; // battle only: AI layers for the east side (default 'none' = rule-based)
  aiTiming?: AITiming; // battle only: does the simulation wait for AI answers (D4)
  friendlyModel?: LlmModel; // battle only: LLM model for each side (D29)
  enemyModel?: LlmModel;
}

export const DEFAULT_CONFIG: SimConfig = {
  mode: 'classic',
  warriorCount: 300,
  waveMultiplier: 1,
  terrainDensity: 'normal',
  heroesPerSide: 1,
};

export const BATTLE_CONFIG: SimConfig = {
  mode: 'battle',
  warriorCount: 150,
  waveMultiplier: 0,
  terrainDensity: 'normal',
  heroesPerSide: 3,
};
