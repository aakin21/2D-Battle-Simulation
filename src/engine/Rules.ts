// The numbers that define how units behave. The engine uses them, and the AI layers'
// rule descriptions are built from them (src/ai/GameRules.ts), so the prompts always match
// the simulation. Change a rule here and both follow.

export const COMBAT_RANGE = 2; // tiles: units fight anything this close
export const ATTACK_INTERVAL = 1.0; // seconds between attacks

// Courage (soldiers only)
export const FLEE_THRESHOLD = 25; // at or below: the soldier flees
export const FLEE_SPEED_MULT = 1.5;
// Battle mode (D57): a fleeing soldier runs until no enemy is in its sight ("rout"); it turns back
// earlier only when one of its heroes is within its charisma radius and its courage is back to this
export const RALLY_COURAGE = 40;
// Battle mode (D57): a flight may turn this far from straight away from the nearest enemy; when
// even that way is blocked (mountain, map edge) the soldier fights instead (turning further would
// not take it away from the enemy)
export const FLEE_MAX_TURN_DEGREES = 45;
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
// Battle-mode heroes (D45): below this HP a hero rests whenever it stands still with no enemy in
// sight (half of its 200 HP; at 50 HP a hero at 40% never healed and stayed in its reflex)
export const HERO_REST_TRIGGER_HP = 100;

// Hero survival reflex (D18)
export const HERO_RETREAT_HP_RATIO = 0.5;
export const HERO_OUTNUMBERED_MIN_ENEMIES = 5;
export const HERO_OUTNUMBERED_RATIO = 2;
// D47: below this share of its HP a hero flees from any enemy in sight, and no order ends it
export const HERO_CRITICAL_HP_RATIO = 0.25;
// D47: an order that ends a flight keeps the reflex off this long at most (one Jev interval plus
// its answer time), not until the sight is clear, which never happens in a fight
export const HERO_REFLEX_OFF_SECONDS = 5;

// Retreat order: fall back from the enemies within RETREAT_SCAN tiles of the hero as far as the
// hero walks in RETREAT_SECONDS (about 10 tiles): until Jev's next decision is in effect, one
// interval (4 s) plus its answer time (about 1 s). A longer retreat is followed by the enemies
// and ends in a fight before the next decision arrives
export const RETREAT_SECONDS = 5;
export const RETREAT_SCAN = 20;

// Room per unit (battle mode): units closer than this push each other apart, at most this fast
export const SEPARATION_RADIUS = 0.9; // tiles
export const SEPARATION_SPEED = 2; // tiles/s, a soldier's walking speed
export const SEPARATION_DEAD_ZONE = 0.15; // a smaller total overlap does not push

// The hero behind its soldiers (D48, battle mode): with enemies in its sight and an order other
// than attack, attack_hero, attack_base or retreat, the hero stands this far behind the middle of
// its soldiers, on the side away from the enemies, and keeps doing so this long after the last
// enemy left its sight; with fewer soldiers than this near it, it walks to its target itself
export const HERO_BEHIND_TILES = 3.5;
export const HERO_BEHIND_HOLD_SECONDS = 3;
export const HERO_BEHIND_MIN_SOLDIERS = 3;
// D55: attack and lead go for the nearest enemy in the hero's sight and keep after the enemy they
// went for (out of sight too: behind its soldiers, in a forest, around a mountain) until it dies
// or is farther than this
export const ATTACK_CHASE_TILES = 30;

// Breaking off a fight (D27): a hero that breaks off ignores enemies until none is this close
export const DISENGAGE_CLEAR_RADIUS = 6;

// Objectives (D30)
export const CONTROL_RADIUS = 8; // tiles: units this close to a point count for it
export const CONTROL_POINTS_PER_SEC = 1; // per point held
// A side holds a point (and scores) once it has had the most units near it this long in a row
export const CONTROL_CAPTURE_SECONDS = 3;
export const CONTROL_TIME_LIMIT = 480; // seconds (8 min; 300 until 2026-10-18)
export const MATCH_TIME_LIMIT = 500; // seconds: elimination and base modes
export const BASE_HP = 3000;
export const BASE_RADIUS = 3; // tiles: units within BASE_RADIUS + COMBAT_RANGE can hit the base
