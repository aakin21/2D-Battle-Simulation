import type { LlmModel, TacticalModel } from '../ai/Models';

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
  path: Position[]; // A* path to follow — empty when there is nowhere to go or in combat
  target: string | null; // ID of the unit being attacked (null = no target)
  attackCooldown: number; // seconds until next attack (0 = ready)
  groupId: string; // spawn group identifier — used for coordinated berserker patrol
}

// Who gives a hero its orders. 'rule' heroes patrol and charge on their own (no AI);
// 'ai' heroes get orders from the AI layers attached to the match (Jev and/or the LLM).
export type HeroController = 'user' | 'rule' | 'ai';

// Which AI layers command a side in battle mode: the LLM alone, or the LLM with a tactical layer
// (Jev or SubQ Snap, D51; the model is chosen separately). Jev alone was dropped: it sees only each hero's surroundings, so it cannot
// command a side by itself. 'none': the user (west) or the rule layer (east).
export type SideAI = 'none' | 'llm' | 'jev+llm';

// D4: 'realtime' keeps the battle running and applies AI answers when they arrive;
// 'paused' freezes the battle until every pending AI answer has arrived.
export type AITiming = 'realtime' | 'paused';

// D29, D52: the LLM of a side, and D51: its tactical decision model (src/ai/Models.ts)
export type { LlmModel, TacticalModel };

// Orders a hero can receive (D20). Every source (user, rule, Jev, LLM) uses the same set.
export type HeroCommand = (
  | { type: 'move'; target: Position } // AI gives a sector, the user an exact point
  | { type: 'hold'; at: Position }
  | { type: 'retreat'; to?: Position } // fall back a short way from the enemies (set on issue)
  | { type: 'attack' } // the hero leads the charge and fights in front
  | { type: 'lead' } // the soldiers charge the nearest enemy, the hero follows behind them (D48)
  | { type: 'attackHero'; heroIndex: number }
  | { type: 'regroup' } // collect stray soldiers of the hero's side, group after group (D28)
  | { type: 'attackBase' } // walk to the enemy base and attack it (base mode, D30)
  | { type: 'continueLlm' } // Jev only: keep following the LLM's latest command
) & {
  // Why the order was given (the LLM writes one per order); Jev reads it to judge whether the
  // order still fits. The engine ignores it.
  reason?: string;
};

export type CommandSource = 'user' | 'rule' | 'jev' | 'llm';

export interface IHero extends IUnit {
  taskPoint: Position | null; // where the hero is heading; derived from `command` each frame
  charismaRadius: number;
  charismaBonus: number;
  controller: HeroController;
  heroIndex: number; // 1-based number within its side, used by "attack hero N"
  home: Position; // start position; a retreat's fallback when it has no point of its own (D39)
  command: HeroCommand | null;
  commandSource: CommandSource | null;
  commandTime: number; // simulation time of the last command
  lastLlmCommand: HeroCommand | null; // kept so Jev can see and resume the LLM's plan (D15)
  lastLlmTime: number; // simulation time of the LLM's latest command
  disengaging: boolean; // breaking off a fight: ignores enemies until clear of them (D27)
  reflexOverridden: boolean; // an order ended the survival reflex; off for a while (D18, D47)
  reflexOverriddenAt: number; // simulation time of that order
  // D48: where the hero itself stands while enemies are near (behind its soldiers), the group
  // still going to taskPoint; null when it walks to taskPoint itself
  standPoint: Position | null;
  standUntil: number; // simulation time until which the hero stays behind (enemies just left)
  attackTargetId: string | null; // D55: the enemy its attack or lead order goes for
}

// D30: battle objectives. 'elimination': destroy every enemy unit. 'control': hold points
// A and B for points, the match lasts a fixed time. 'base': destroy the enemy base.
export type Objective = 'elimination' | 'control' | 'base';

export interface ControlPoint {
  name: string; // "A" or "B"
  position: Position;
  holder: Faction | null; // side that holds it and scores: it has had the most units in range for CONTROL_CAPTURE_SECONDS (null: nobody yet, a tie or empty)
  leader: Faction | null; // side with the most units in range right now
  leaderSince: number; // simulation time since which `leader` has had the most units
}

export interface Base {
  faction: Faction;
  position: Position;
  hp: number;
  maxHp: number;
}

export interface ObjectiveState {
  mode: Objective;
  points: ControlPoint[]; // control mode
  scores: { friendly: number; enemy: number }; // control mode
  timeLimit: number | null; // seconds
  bases: Base[]; // base mode
}

export interface IBattlefield {
  grid: TerrainType[][];
  units: IUnit[];
  elapsedTime: number;
  objective: ObjectiveState;
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
export const LAST_TILE = GRID_SIZE - 1;
// Tiles off the map's outer border (1..148)
export const INNER_MIN = 1;
export const INNER_MAX = GRID_SIZE - 2;
// Classic waves spawn, and patrols aim, at least this many tiles from the map's edge (5..144)
export const EDGE_MARGIN = 5;
export const EDGE_MARGIN_MAX = LAST_TILE - EDGE_MARGIN;
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
  recordReplay?: boolean; // battle only: keep a replay of the match (UI only, default on)
  objective?: Objective; // battle only (D30), default 'elimination'
  friendlyModel?: LlmModel; // battle only: LLM model for each side (D29, D52)
  enemyModel?: LlmModel;
  friendlyTactical?: TacticalModel; // battle only, with 'jev+llm': the tactical model (D51)
  enemyTactical?: TacticalModel;
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
