import { StateManager } from '../state/StateManager';
import { Pathfinder } from './Pathfinder';
import { GroupPatrol } from './GroupPatrol';
import {
  IUnit,
  IBattlefield,
  TerrainType,
  Position,
  LAST_TILE,
  INNER_MIN,
  INNER_MAX,
  EDGE_MARGIN,
  EDGE_MARGIN_MAX,
} from '../types/types';

// Classic mode (Phase 1, D19): berserker waves from the map edges, and how a wave berserker
// chases its target or patrols with its group. Battle mode never runs it (until 2026-10-25 it
// called updateWaves with a wave multiplier of 0, which spawned nobody but drew random numbers
// and found one path per wave).

// Wave spawn points along an edge: tiles EDGE_MARGIN..EDGE_MARGIN_MAX
const EDGE_SPAN = EDGE_MARGIN_MAX - EDGE_MARGIN + 1;

// Spawns the next wave when its time has come: three fixed waves, then random ones.
export function updateWaves(sm: StateManager, bf: IBattlefield, waveMultiplier: number): void {
  const { elapsedTime, waveNumber } = bf;

  if (waveNumber < 3) {
    if (elapsedTime < bf.nextWaveTime) return;

    const sizes = [100, 150, 200];
    const nextTimes = [90, 180, 210];

    spawnBerserkerWave(sm, Math.round(sizes[waveNumber] * waveMultiplier));

    bf.nextWaveTime = nextTimes[waveNumber];
    bf.waveNumber++;
  } else {
    if (elapsedTime < bf.nextWaveTime) return;

    const size = Math.round((40 + Math.floor(Math.random() * 21)) * waveMultiplier);
    spawnBerserkerWave(sm, size);

    bf.nextWaveTime = elapsedTime + 20 + Math.random() * 20;
    bf.waveNumber++;
  }
}

function spawnBerserkerWave(sm: StateManager, count: number): void {
  const bf = sm.getBattlefield();
  const points = generateSpawnPoints(sm, count);

  const sharedPaths: Position[][] = points.map((origin) => {
    const angle = Math.random() * Math.PI * 2;
    const d = 20 + Math.random() * 20;
    const px = Math.round(
      Math.max(EDGE_MARGIN, Math.min(EDGE_MARGIN_MAX, origin.x + Math.cos(angle) * d))
    );
    const py = Math.round(
      Math.max(EDGE_MARGIN, Math.min(EDGE_MARGIN_MAX, origin.y + Math.sin(angle) * d))
    );
    return Pathfinder.findPath(bf.grid, { x: origin.x, y: origin.y }, { x: px, y: py });
  });

  const waveNum = bf.waveNumber;

  for (let i = 0; i < count; i++) {
    const idx = i % points.length;
    const origin = points[idx];
    let x = Math.round(origin.x + (Math.random() * 6 - 3));
    let y = Math.round(origin.y + (Math.random() * 6 - 3));
    x = Math.max(INNER_MIN, Math.min(INNER_MAX, x));
    y = Math.max(INNER_MIN, Math.min(INNER_MAX, y));

    if (bf.grid[y]?.[x] === TerrainType.MOUNTAIN) {
      x = origin.x;
      y = origin.y;
    }

    const groupId = `w${waveNum}_p${idx}`;
    sm.spawnBerserker(x, y, groupId, sharedPaths[idx].slice());
  }
}

function generateSpawnPoints(sm: StateManager, count: number): Position[] {
  const numPoints = Math.max(1, Math.min(8, Math.ceil(count / 20)));
  const points: Position[] = [];
  let attempts = 0;

  while (points.length < numPoints && attempts < 200) {
    attempts++;

    const edge = Math.floor(Math.random() * 4);
    const inset = EDGE_MARGIN + Math.floor(Math.random() * 21);
    let x: number;
    let y: number;

    if (edge === 0) {
      x = EDGE_MARGIN + Math.floor(Math.random() * EDGE_SPAN);
      y = inset;
    } else if (edge === 1) {
      x = EDGE_MARGIN + Math.floor(Math.random() * EDGE_SPAN);
      y = LAST_TILE - inset;
    } else if (edge === 2) {
      x = inset;
      y = EDGE_MARGIN + Math.floor(Math.random() * EDGE_SPAN);
    } else {
      x = LAST_TILE - inset;
      y = EDGE_MARGIN + Math.floor(Math.random() * EDGE_SPAN);
    }

    const tooClose = points.some((p) => {
      const dx = p.x - x;
      const dy = p.y - y;
      return dx * dx + dy * dy < 20 * 20;
    });

    if (!tooClose && sm.isClearTile(x, y)) points.push({ x, y });
  }

  if (points.length === 0) points.push({ x: EDGE_MARGIN, y: EDGE_MARGIN });
  return points;
}

// The path of an idle wave berserker: toward a tile next to its living target (each berserker
// aims at its own spot around the target), or, with no target, toward its group's patrol
// destination. The caller then moves it along the path.
export function updateBerserkerPath(
  sm: StateManager,
  patrol: GroupPatrol,
  unit: IUnit,
  grid: TerrainType[][]
): void {
  if (unit.target !== null) {
    const target = sm.getUnitById(unit.target);
    if (target && target.hp > 0) {
      const dtx = Math.floor(target.position.x);
      const dty = Math.floor(target.position.y);

      const idNum = parseInt(unit.id.replace('unit_', '')) || 0;
      const angle = (idNum * 2.399963) % (Math.PI * 2);
      const r = 1.0 + (idNum % 3) * 0.4;
      let aimX = Math.max(INNER_MIN, Math.min(INNER_MAX, dtx + Math.round(Math.cos(angle) * r)));
      let aimY = Math.max(INNER_MIN, Math.min(INNER_MAX, dty + Math.round(Math.sin(angle) * r)));
      if (!sm.isClearTile(aimX, aimY)) {
        aimX = dtx;
        aimY = dty;
      }

      const pe = unit.path.length > 0 ? unit.path[unit.path.length - 1] : null;
      if (!pe || pe.x !== aimX || pe.y !== aimY) {
        const st = { x: Math.floor(unit.position.x), y: Math.floor(unit.position.y) };
        unit.path = Pathfinder.findPath(grid, st, { x: aimX, y: aimY });
      }
    } else {
      unit.target = null;
      unit.path = [];
    }
  } else if (unit.path.length === 0) {
    const elapsed = sm.getBattlefield().elapsedTime;
    const dest = patrol.destination(unit.groupId, unit.position, elapsed);
    const dtx = Math.floor(dest.x);
    const dty = Math.floor(dest.y);
    if (Math.floor(unit.position.x) !== dtx || Math.floor(unit.position.y) !== dty) {
      const st = { x: Math.floor(unit.position.x), y: Math.floor(unit.position.y) };
      unit.path = Pathfinder.findPath(grid, st, { x: dtx, y: dty });
      if (unit.path.length === 0) patrol.forget(unit.groupId);
    }
  }
}
