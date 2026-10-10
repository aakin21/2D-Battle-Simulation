import { UNIT_STATS, TERRAIN_SPEED, TERRAIN_SIGHT, GRID_SIZE, Objective } from '../types/types';
import { SECTOR_SIZE, SECTORS_PER_SIDE } from '../engine/Sectors';
import * as R from '../engine/Rules';

// The rulebook given to the AI layers (D26). Built from the same constants the engine uses,
// so the text cannot drift from the simulation. The LLM gets it once per match as its system
// prompt; Jev has no memory, so it gets the relevant part inside every request's state.

const W = UNIT_STATS.WARRIOR;
const H = UNIT_STATS.HERO;
const pct = (x: number) => `${Math.round(x * 100)}%`;
// A unit's damage is dealt once per attack interval
const perSecond = (damage: number) => Math.round((10 * damage) / R.ATTACK_INTERVAL) / 10;

// How often Jev decides for each hero (D1, D21) and how far its "step" options go; the Jev
// layer uses these values
export const JEV_INTERVAL_SEC = 4;
export const JEV_STEP_TILES = 10;

// Battle-mode heroes move at their soldiers' speed (D18).
const UNITS = `Both sides are identical. Soldier: ${W.hp} HP, ${perSecond(W.damage)} damage per second, moves ${W.speed} tiles/s, sees ${W.sight} tiles. Hero: ${H.hp} HP, ${perSecond(H.damage)} damage per second, moves ${W.speed} tiles/s (same as its soldiers), sees ${H.sight} tiles. Units fight any enemy within ${R.COMBAT_RANGE} tiles automatically; damage is the same from every direction.`;

const FOLLOWING = `A soldier follows the nearest hero of its side if that hero is within ${H.sight} tiles. A soldier with no hero of its side that close is a stray: it stays where it is and only fights enemies that come into its sight, until a hero comes within ${H.sight} tiles of it again (use regroup to collect strays); strays also miss the charisma bonus. When a side has no heroes left, its soldiers attack the nearest enemy. A hero that runs too far ahead leaves its soldiers behind as strays.`;

const COURAGE = `Courage (soldiers only, recalculated all the time) = ${W.courage}, minus ${R.WOUND_PENALTY} for every ${pct(R.WOUND_STEP)} of HP lost, plus ${R.ALLY_SHARE_HIGH_BONUS} if more than ${pct(R.ALLY_SHARE_HIGH)} of the units it sees are allies, minus ${R.ALLY_SHARE_LOW_PENALTY} if fewer than ${pct(R.ALLY_SHARE_LOW)} are allies (minus ${R.ALLY_SHARE_VERY_LOW_PENALTY} if fewer than ${pct(R.ALLY_SHARE_VERY_LOW)}), plus ${R.CHARISMA_BONUS} if one of its heroes is within ${R.CHARISMA_RADIUS} tiles. A soldier with courage ${R.FLEE_THRESHOLD} or less flees from enemies at ${R.FLEE_SPEED_MULT}x speed and cannot be ordered back. Orders never change courage.`;

const CHARISMA = `A hero's charisma gives +${R.CHARISMA_BONUS} COURAGE (not damage) to its soldiers within ${R.CHARISMA_RADIUS} tiles. When a hero dies its soldiers lose this bonus and may start to flee.`;

const REST = `A unit below ${R.REST_TRIGGER_HP} HP with no enemy in sight stops to rest and heals ${R.REST_HEAL_PER_SEC} HP/s.`;

const REFLEX = `Hero survival reflex: when enemies are in a hero's sight and its HP is below ${pct(R.HERO_RETREAT_HP_RATIO)}, or at least ${R.HERO_OUTNUMBERED_MIN_ENEMIES} enemies outnumber its allies ${R.HERO_OUTNUMBERED_RATIO} to 1 in its sight, the hero automatically flees: it moves straight away from the enemies (not home) until none is in its sight, then resumes its order. Its soldiers do not flee with it; they keep fighting. You can end the flight by giving the hero a different order (repeating its current order does not); the reflex then stays off for that hero until no enemy is in its sight.`;

const BREAK_OFF = `A hero on a move or retreat order fights enemies it meets on the way and then continues to its target. If a different order arrives while it is fighting, it breaks off: it ignores enemies until none is within ${R.DISENGAGE_CLEAR_RADIUS} tiles, then fights normally again; retreat always breaks off. Its soldiers do not break off with it and keep fighting. Repeating the same order changes nothing; it is how you keep a plan.`;

const TERRAIN = `Terrain: forest slows movement to ${pct(TERRAIN_SPEED.FOREST)} and sight to ${pct(TERRAIN_SIGHT.FOREST)}; swamp slows movement to ${pct(TERRAIN_SPEED.SWAMP)} and sight to ${pct(TERRAIN_SIGHT.SWAMP)}; mountains are impassable.`;

const MAP = `The map is ${GRID_SIZE}x${GRID_SIZE} tiles, split into ${SECTORS_PER_SIDE}x${SECTORS_PER_SIDE} sectors of ${SECTOR_SIZE}x${SECTOR_SIZE} tiles. Columns A-J run west to east, rows 1-10 north to south. Each sector is split 3x3 into sub-sectors of 5x5 tiles named NW, N, NE, W, C, E, SW, S, SE, e.g. "D4-NE" is the north-east corner of D4; "D4" alone means its centre. Exact places are also given as tiles (x, y): x counts from 0 at the west edge to ${GRID_SIZE - 1} at the east edge, y from 0 at the north edge to ${GRID_SIZE - 1} at the south edge.`;

const JEV_FOR_LLM = `A fast tactical system (Jev) watches each of your heroes and decides every ${JEV_INTERVAL_SEC} seconds, using only what is around that hero. It can briefly override your order to handle the local situation (hold, retreat, attack, attack a nearby enemy hero, collect nearby strays, go to a control point or attack the enemy base when the mode has them, or step about ${JEV_STEP_TILES} tiles in some direction), and returns to your order when the situation allows. The report shows Jev's recent decisions and its assessment of each hero (surrounded, threat level, whether your order still fits). You set the plan; Jev handles the moment.`;

// D30: what wins the match, per objective.
export function goalText(objective: Objective): string {
  switch (objective) {
    case 'control':
      return `Control points A and B. At every moment, the side with more units (not counting fleeing ones) within ${R.CONTROL_RADIUS} tiles of a point scores ${R.CONTROL_POINTS_PER_SEC} point per second for it. The match lasts ${R.CONTROL_TIME_LIMIT} seconds; then the side with more points wins (equal points: more total HP left). Destroying every enemy unit also wins at once. Points are only scored while you hold them, so waiting away from the points loses.`;
    case 'base':
      return `Destroy the enemy base. Each side has a base (${R.BASE_HP} HP) at its start area. Units within ${R.BASE_RADIUS + R.COMBAT_RANGE} tiles of the enemy base hit it with their normal damage when they are not fighting a unit; bases do not fight back. The side whose base is destroyed loses. Destroying every enemy unit also wins. The match lasts at most ${R.MATCH_TIME_LIMIT} seconds; if no base has fallen by then, the side with more total HP left wins.`;
    default:
      return `Destroy every enemy unit (heroes and soldiers). The side that loses all its units loses. The match lasts at most ${R.MATCH_TIME_LIMIT} seconds; then the side with more total HP left wins.`;
  }
}

function objectiveOrders(objective: Objective): string {
  if (objective === 'control')
    return '\n- move A / move B: walk to control point A or B and stay there (same as move to its place).';
  if (objective === 'base')
    return '\n- attack_base: walk to the enemy base and attack it; the hero and its soldiers still fight enemy units they meet.';
  return '';
}

export function llmSystemPrompt(
  side: 'west' | 'east',
  withJev: boolean,
  intervalSec: number,
  objective: Objective = 'elimination'
): string {
  return `You are the strategic commander of the ${side} side in a 2D battle simulation. Every ${intervalSec} seconds you receive a report of the whole battlefield and give one order to each of your living heroes.

GOAL: ${goalText(objective)}

MAP: ${MAP}

UNITS: ${UNITS}

FOLLOWING: ${FOLLOWING}

COURAGE: ${COURAGE}
CHARISMA: ${CHARISMA}
REST: ${REST}

${REFLEX}

${TERRAIN}
${withJev ? `\n${JEV_FOR_LLM}\n` : ''}
ORDERS:
- move <place>: walk to that sector or sub-sector ("D4" or "D4-NE") and stay there.
- hold: stay at the current position and fight what comes.
- retreat: fall back about ${R.RETREAT_TILES} tiles away from the enemies near the hero (not to its start position), then stay there.
- attack: walk toward the nearest enemy unit, wherever it is.
- attack_hero <n>: walk toward enemy hero n's current position and keep following it as it moves. Your hero and its soldiers still fight every enemy they meet on the way. Killing a hero removes its +${R.CHARISMA_BONUS} courage bonus from its soldiers.
- regroup: collect your stray soldiers: the hero walks to one group after another (nearer and bigger groups first) until none is left, then stays; strays follow the hero again once it is within ${H.sight} tiles and regain the courage bonus near it. If you have no strays, the hero stays where it is.${objectiveOrders(objective)}
Give every order a short "reason": what it is for and what would make it pointless (e.g. "take A before the enemy arrives; pointless if A is already ours"). The reason is logged, and a tactical layer, if you have one, uses it to judge whether the order still fits.
FIGHTING AND BREAKING OFF: ${BREAK_OFF}

STANCE: keep one stance and change it only when its condition is met.
- aggressive: seek battle. Switch to defensive if your army's total HP falls below 70% of the enemy's.
- defensive: hold good ground and let the enemy come. Switch to aggressive if your army's total HP exceeds 120% of the enemy's, or the enemy has stayed passive for 60 seconds.
- regroup: bring heroes and soldiers back together after heavy losses or when many soldiers are strays (use the regroup order). Switch when they are together again.

Think in this order: what the report shows, what changed since your last report, which stance fits, your plan, the orders.
Reply with ONLY this JSON, no other text:
{"situation": "<one sentence>", "change": "<one sentence>", "stance": "aggressive|defensive|regroup", "plan": "<one sentence>", "orders": [{"hero": 1, "command": "move", "place": "D4-NE", "reason": "<what it is for>"}, {"hero": 2, "command": "attack_hero", "target_hero": 3, "reason": "<what it is for>"}, {"hero": 3, "command": "hold", "reason": "<what it is for>"}]}`;
}

// The part of the rulebook Jev needs for local decisions (D16): no goal or stance.
// withCommander: an LLM sets the plan on the same side. Without one, Jev also gets the goal,
// otherwise it has no reason to do anything but wait.
export function jevGameRules(withCommander: boolean, objective: Objective): Record<string, string> {
  return {
    your_role: withCommander
      ? "You are the tactical layer. A strategic commander (an LLM) sets the overall plan and gives each hero an order with its reason; you decide what each hero should do right now, based on its surroundings. Follow the commander's order while its reason still holds here; when the situation shows the reason no longer holds (the target is gone or already taken, the enemy here is much stronger or weaker than the commander expected, the hero is about to be surrounded), choose what fits, and return to the order when it fits again."
      : 'You command these heroes alone; there is no strategic commander. Decide what each hero should do right now to win. Standing still never wins.',
    goal: goalText(objective),
    map: MAP,
    units: UNITS,
    following: FOLLOWING,
    courage: COURAGE,
    charisma: CHARISMA,
    rest: REST,
    hero_reflex: REFLEX,
    breaking_off: BREAK_OFF,
    terrain: TERRAIN,
    force_ratio: `force_ratio is the total HP of your units divided by the total HP of enemy units within 15 tiles of the hero. Above 1 you are stronger here; the trend compares it with ${JEV_INTERVAL_SEC} seconds ago.`,
  };
}
