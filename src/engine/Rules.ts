// The numbers that define how units behave. The engine uses them, and the AI layers'
// rule descriptions are built from them (src/ai/GameRules.ts), so the prompts always match
// the simulation. Change a rule here and both follow.

export const COMBAT_RANGE = 2; // tiles: units fight anything this close
export const ATTACK_INTERVAL = 1.0; // seconds between attacks

// Courage (soldiers only)
export const FLEE_THRESHOLD = 25; // at or below: the soldier flees
export const FLEE_SPEED_MULT = 1.5;
export const WOUND_STEP = 0.2; // every 20% of HP lost...
export const WOUND_PENALTY = 10; // ...costs this much courage
export const ALLY_SHARE_HIGH = 0.6; // more allies than this share in sight...
export const ALLY_SHARE_HIGH_BONUS = 15; // ...gives this bonus
export const ALLY_SHARE_LOW = 0.4; // fewer than this share...
export const ALLY_SHARE_LOW_PENALTY = 15;
export const ALLY_SHARE_VERY_LOW = 0.2; // fewer than this share...
export const ALLY_SHARE_VERY_LOW_PENALTY = 30;
export const CHARISMA_RADIUS = 10; // tiles
export const CHARISMA_BONUS = 20; // courage, not damage

// Rest
export const REST_TRIGGER_HP = 50; // below this HP, with no enemy in sight, a unit rests
export const REST_HEAL_PER_SEC = 10;

// Hero survival reflex (D18)
export const HERO_RETREAT_HP_RATIO = 0.5;
export const HERO_OUTNUMBERED_MIN_ENEMIES = 5;
export const HERO_OUTNUMBERED_RATIO = 2;

// Retreat order: fall back this far from the enemies within RETREAT_SCAN tiles of the hero
export const RETREAT_TILES = 12;
export const RETREAT_SCAN = 20;

// Breaking off a fight (D27): a hero that breaks off ignores enemies until none is this close
export const DISENGAGE_CLEAR_RADIUS = 6;

// Objectives (D30)
export const CONTROL_RADIUS = 8; // tiles: units this close to a point count for it
export const CONTROL_POINTS_PER_SEC = 1; // per point held
export const CONTROL_TIME_LIMIT = 300; // seconds
export const MATCH_TIME_LIMIT = 500; // seconds: elimination and base modes
export const BASE_HP = 3000;
export const BASE_RADIUS = 3; // tiles: units within BASE_RADIUS + COMBAT_RANGE can hit the base
