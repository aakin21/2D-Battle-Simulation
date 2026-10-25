import { StateManager } from '../state/StateManager';
import { IUnit, IHero, UnitType, BehaviorState, TerrainType, Position } from '../types/types';
import { Pathfinder } from './Pathfinder';
import { GroupPatrol } from './GroupPatrol';
import { updateBerserkerPath } from './ClassicWaves';
import { moveHeroRetreat } from './HeroReflex';
import { attackOrIdle } from './Behavior';
import { Followers, findLeader, isSoldier } from './Soldiers';
import { WOUNDED_SPEED_MIN } from './Rules';
import {
  canStep,
  findNearestEnemy,
  fleeWayOpen,
  nearestReachableTile,
  stepToward,
  terrainSpeed,
} from './UnitHelpers';

// Movement for one frame: fleeing units run, wave berserkers chase or patrol (classic), heroes
// walk to their task point and soldiers to their hero's, along A* paths.

export function moveUnit(
  sm: StateManager,
  unit: IUnit,
  deltaTime: number,
  grid: TerrainType[][],
  battleMode: boolean,
  patrol: GroupPatrol,
  followers: Followers
): void {
  if (unit.state === BehaviorState.FLEE) {
    if (unit.unitType === UnitType.HERO) moveHeroRetreat(sm, unit as IHero, deltaTime, grid);
    else moveFlee(sm, unit, deltaTime, grid, battleMode);
    return;
  }

  // Classic wave berserker: chase its target or patrol with its group (ClassicWaves.ts)
  if (unit.unitType === UnitType.BERSERKER && !battleMode) {
    if (unit.state !== BehaviorState.IDLE) return;

    updateBerserkerPath(sm, patrol, unit, grid);
    followPath(unit, deltaTime, grid, false);
    return;
  }

  if (unit.state !== BehaviorState.IDLE) return;

  const soldier = isSoldier(unit, battleMode);
  const leader = soldier ? findLeader(sm, unit) : undefined;
  const dest = destination(sm, unit, leader, battleMode);
  if (!dest) {
    unit.path = [];
    return;
  }

  // A soldier stops near its standing hero, but not while the hero only stands behind it: then
  // the group goes on to the order's point (D48)
  if (soldier && unit.target === null && leader && leader.path.length === 0 && !leader.standPoint) {
    const dx = leader.position.x - unit.position.x;
    const dy = leader.position.y - unit.position.y;
    const arrive = followers.arriveRadius(leader, battleMode);
    if (dx * dx + dy * dy <= arrive * arrive) {
      unit.path = [];
      return;
    }
  }

  const destTileX = Math.floor(dest.x);
  const destTileY = Math.floor(dest.y);
  const pathEnd = unit.path.length > 0 ? unit.path[unit.path.length - 1] : null;

  if (!pathEnd || pathEnd.x !== destTileX || pathEnd.y !== destTileY) {
    const startTile: Position = {
      x: Math.floor(unit.position.x),
      y: Math.floor(unit.position.y),
    };
    unit.path = Pathfinder.findPath(grid, startTile, { x: destTileX, y: destTileY });
  }

  followPath(unit, deltaTime, grid, battleMode);
}

// Straight away from the nearest enemy, at flee speed
function moveFlee(
  sm: StateManager,
  unit: IUnit,
  deltaTime: number,
  grid: TerrainType[][],
  battleMode: boolean
): void {
  const enemy = findNearestEnemy(sm, unit);
  if (!enemy) return;

  const dx = unit.position.x - enemy.position.x;
  const dy = unit.position.y - enemy.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return;

  const away = Math.atan2(dy, dx);
  // Battle mode (D57): with its way away blocked (a mountain, the map's edge), even turning up to
  // FLEE_MAX_TURN_DEGREES, a soldier stops fleeing and fights the nearest enemy; it used to stand
  // there and be cut down. While its courage stays low it tries to flee again every frame.
  if (battleMode && isSoldier(unit, battleMode) && !fleeWayOpen(unit, away, deltaTime, grid)) {
    attackOrIdle(unit, enemy, true);
    return;
  }
  stepToward(sm, unit, away, deltaTime, grid, battleMode);
}

// One step toward the centre of the path's next tile; the tile is dropped once reached.
function followPath(
  unit: IUnit,
  deltaTime: number,
  grid: TerrainType[][],
  battleMode: boolean
): void {
  if (unit.path.length === 0) return;

  const waypoint = unit.path[0];
  const wpx = waypoint.x + 0.5;
  const wpy = waypoint.y + 0.5;

  const speed = walkSpeed(unit, grid);
  if (speed === 0) return;

  const dx = wpx - unit.position.x;
  const dy = wpy - unit.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = speed * deltaTime;
  const reached = dist <= step;
  let nx = reached ? wpx : unit.position.x + (dx / dist) * step;
  let ny = reached ? wpy : unit.position.y + (dy / dist) * step;

  // Battle mode: a step never enters a mountain or a tile next to one. A path's straight
  // segments are clear, but units pushed off them (D53) walked to the next waypoint through
  // mountain corners, and in a narrow pass dozens ended up inside the mountains (CASES 16.x).
  // The unit slides along the obstacle, or plans its path again from where it stands.
  if (battleMode && !canStep(grid, unit.position.x, unit.position.y, nx, ny)) {
    if (canStep(grid, unit.position.x, unit.position.y, nx, unit.position.y)) ny = unit.position.y;
    else if (canStep(grid, unit.position.x, unit.position.y, unit.position.x, ny))
      nx = unit.position.x;
    else {
      // The path's straight line cuts the corner where two blocked tiles meet: follow the
      // unsmoothed path from here, tile by tile through tile edges, which every step can take
      const end = unit.path[unit.path.length - 1];
      unit.path = Pathfinder.findPath(
        grid,
        { x: Math.floor(unit.position.x), y: Math.floor(unit.position.y) },
        end,
        false
      );
      return;
    }
    unit.position.x = nx;
    unit.position.y = ny;
    return;
  }

  unit.position.x = nx;
  unit.position.y = ny;
  if (reached) unit.path.shift();
}

// Where an idle unit walks: to its target, else a hero to where it stands or its task point and a
// soldier to its hero's task point. leader: the hero this soldier follows (within its sight).
function destination(
  sm: StateManager,
  unit: IUnit,
  leader: IHero | undefined,
  battleMode: boolean
): Position | null {
  if (unit.target !== null) {
    const target = sm.getUnitById(unit.target);
    if (target && target.hp > 0) {
      // Battle mode: a target standing on a tile the pathfinder treats as blocked (next to a
      // mountain) is approached on the nearest reachable tile, within reach of a blow; walking
      // to its own tile found no path, and the attacker stood still (CASES 14.x)
      if (!battleMode) return target.position;
      const tx = Math.floor(target.position.x);
      const ty = Math.floor(target.position.y);
      if (!Pathfinder.isBlocked(sm.getBattlefield().grid, tx, ty)) return target.position;
      const t = nearestReachableTile(sm, target.position);
      return { x: t.x + 0.5, y: t.y + 0.5 };
    }
  }

  if (unit.unitType === UnitType.HERO) {
    const hero = unit as IHero;
    return hero.standPoint ?? hero.taskPoint ?? null;
  }
  // A soldier with no hero of its side within sight is a stray: it stays where it is (and
  // fights what comes close) until a hero comes to collect it (regroup order, D35). It also
  // stays when its side has no heroes left; the time limit ends the match (D33, D42).
  if (isSoldier(unit, battleMode) && leader) return leader.taskPoint ?? null;
  return null;
}

// Walking speed: base speed, slowed by wounds (down to WOUNDED_SPEED_MIN) and by the terrain
function walkSpeed(unit: IUnit, grid: TerrainType[][]): number {
  const xi = Math.floor(unit.position.x);
  const yi = Math.floor(unit.position.y);
  const terrain = grid[yi]?.[xi] ?? TerrainType.MOUNTAIN;
  const terrainMult = terrainSpeed(terrain);
  const hpMult = WOUNDED_SPEED_MIN + (1 - WOUNDED_SPEED_MIN) * (unit.hp / unit.maxHp);
  return unit.baseSpeed * hpMult * terrainMult;
}
