import { UNIT_STATS, TERRAIN_SPEED, TERRAIN_SIGHT, GRID_SIZE } from '../types/types';
import { SECTOR_SIZE, SECTORS_PER_SIDE } from '../engine/Sectors';
import * as R from '../engine/Rules';

// The rulebook given to the AI layers (D26). Built from the same constants the engine uses,
// so the text cannot drift from the simulation. The LLM gets it once per match as its system
// prompt; Jev has no memory, so it gets the relevant part inside every request's state.

const W = UNIT_STATS.WARRIOR;
const H = UNIT_STATS.HERO;
const pct = (x: number) => `${Math.round(x * 100)}%`;

// Battle-mode heroes move at their soldiers' speed (D18).
const UNITS = `Both sides are identical. Soldier: ${W.hp} HP, ${W.damage} damage per second, moves ${W.speed} tiles/s, sees ${W.sight} tiles. Hero: ${H.hp} HP, ${H.damage} damage per second, moves ${W.speed} tiles/s (same as its soldiers), sees ${H.sight} tiles. Units fight any enemy within ${R.COMBAT_RANGE} tiles automatically; damage is the same from every direction.`;

const FOLLOWING = `A soldier follows the nearest hero of its side if that hero is within ${H.sight} tiles. Soldiers farther than that from every hero stop following and act on their own, so a hero that runs too far ahead loses its soldiers.`;

const COURAGE = `Courage (soldiers only, recalculated all the time) = ${W.courage}, minus ${R.WOUND_PENALTY} for every ${pct(R.WOUND_STEP)} of HP lost, plus ${R.ALLY_SHARE_HIGH_BONUS} if more than ${pct(R.ALLY_SHARE_HIGH)} of the units it sees are allies, minus ${R.ALLY_SHARE_LOW_PENALTY} if fewer than ${pct(R.ALLY_SHARE_LOW)} are allies (minus ${R.ALLY_SHARE_VERY_LOW_PENALTY} if fewer than ${pct(R.ALLY_SHARE_VERY_LOW)}), plus ${R.CHARISMA_BONUS} if one of its heroes is within ${R.CHARISMA_RADIUS} tiles. A soldier with courage ${R.FLEE_THRESHOLD} or less flees from enemies at ${R.FLEE_SPEED_MULT}x speed and cannot be ordered back. Orders never change courage.`;

const CHARISMA = `A hero's charisma gives +${R.CHARISMA_BONUS} COURAGE (not damage) to its soldiers within ${R.CHARISMA_RADIUS} tiles. When a hero dies its soldiers lose this bonus and may start to flee.`;

const REST = `A unit below ${R.REST_TRIGGER_HP} HP with no enemy in sight stops to rest and heals ${R.REST_HEAL_PER_SEC} HP/s.`;

const REFLEX = `Hero survival reflex: a hero automatically retreats toward its start position when its HP falls below ${pct(R.HERO_RETREAT_HP_RATIO)}, or when at least ${R.HERO_OUTNUMBERED_MIN_ENEMIES} enemies outnumber its allies ${R.HERO_OUTNUMBERED_RATIO} to 1 in its sight. It obeys orders again at ${pct(R.HERO_RECOVER_HP_RATIO)} HP when no longer outnumbered. The current order is kept and resumes afterwards.`;

const TERRAIN = `Terrain: forest slows movement to ${pct(TERRAIN_SPEED.FOREST)} and sight to ${pct(TERRAIN_SIGHT.FOREST)}; swamp slows movement to ${pct(TERRAIN_SPEED.SWAMP)} and sight to ${pct(TERRAIN_SIGHT.SWAMP)}; mountains are impassable.`;

const MAP = `The map is ${GRID_SIZE}x${GRID_SIZE} tiles, split into ${SECTORS_PER_SIDE}x${SECTORS_PER_SIDE} sectors of ${SECTOR_SIZE}x${SECTOR_SIZE} tiles. Columns A-J run west to east, rows 1-10 north to south. Each sector is split 3x3 into sub-sectors of 5x5 tiles named NW, N, NE, W, C, E, SW, S, SE, e.g. "D4-NE" is the north-east corner of D4; "D4" alone means its centre.`;

const JEV_FOR_LLM = `A fast tactical system (Jev) watches each of your heroes and decides every 4 seconds, using only what is around that hero. It can briefly override your order to handle the local situation (hold, retreat, attack, attack a nearby enemy hero, or step a short distance in some direction), and returns to your order when the situation allows. The report shows Jev's recent decisions and its assessment of each hero (surrounded, threat level, whether your order still fits). You set the plan; Jev handles the moment.`;

export function llmSystemPrompt(
  side: 'west' | 'east',
  withJev: boolean,
  intervalSec: number
): string {
  return `You are the strategic commander of the ${side} side in a 2D battle simulation. Every ${intervalSec} seconds you receive a report of the whole battlefield and give one order to each of your living heroes.

GOAL: destroy every enemy unit (heroes and soldiers). The side that loses all its units loses.

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
- retreat: walk back to the hero's start position.
- attack: walk toward the nearest enemy unit, wherever it is.
- attack_hero <n>: walk toward enemy hero n's current position and keep following it as it moves. Your hero and its soldiers still fight every enemy they meet on the way. Killing a hero removes its +${R.CHARISMA_BONUS} courage bonus from its soldiers.

STANCE: keep one stance and change it only when its condition is met.
- aggressive: seek battle. Switch to defensive if your army's total HP falls below 70% of the enemy's.
- defensive: hold good ground and let the enemy come. Switch to aggressive if your army's total HP exceeds 120% of the enemy's, or the enemy has stayed passive for 60 seconds.
- regroup: bring heroes and soldiers back together after heavy losses. Switch when they are together again.

Think in this order: what the report shows, what changed since your last report, which stance fits, your plan, the orders.
Reply with ONLY this JSON, no other text:
{"situation": "<one sentence>", "change": "<one sentence>", "stance": "aggressive|defensive|regroup", "plan": "<one sentence>", "orders": [{"hero": 1, "command": "move", "place": "D4-NE"}, {"hero": 2, "command": "attack_hero", "target_hero": 3}, {"hero": 3, "command": "hold"}]}`;
}

// The part of the rulebook Jev needs for local decisions (D16): no goal or stance.
export function jevGameRules(): Record<string, string> {
  return {
    your_role:
      'You are the tactical layer. A strategic commander (an LLM) sets the overall plan; you decide what each hero should do right now, based only on its surroundings. You may override the commander briefly to handle danger or opportunity, and return to its order when it fits again.',
    units: UNITS,
    following: FOLLOWING,
    courage: COURAGE,
    charisma: CHARISMA,
    rest: REST,
    hero_reflex: REFLEX,
    terrain: TERRAIN,
    force_ratio:
      'force_ratio is the total HP of your units divided by the total HP of enemy units within 15 tiles of the hero. Above 1 you are stronger here; the trend compares it with 4 seconds ago.',
  };
}
