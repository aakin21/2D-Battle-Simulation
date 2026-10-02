import { IUnit, UnitType, Faction } from '../../types/types';

// Visual effects layer. Reads simulation state, never writes it.
//
// Events are detected by diffing each unit against its state in the previous frame:
//   hp dropped           → hit
//   unit missing by id   → death (last known position is kept)
//   position changed     → facing direction
// The simulation engine is not modified, so effects cannot change simulation results.
//
// Time is simulation time (battlefield.elapsedTime): effects freeze while paused
// and follow the speed multiplier.

interface UnitSnapshot {
  x: number;
  y: number;
  hp: number;
  unitType: UnitType;
  faction: Faction;
  facing: 1 | -1; // 1 = right, -1 = left
  stamp: number; // frame stamp of the last update; stale stamp = unit is gone
}

export interface HitEvent {
  id: string;
  x: number;
  y: number;
  damage: number;
  unitType: UnitType;
}

export interface DeathEvent {
  id: string;
  x: number;
  y: number;
  unitType: UnitType;
  faction: Faction;
  facing: 1 | -1;
}

// Ignore sub-pixel jitter when deciding facing
const FACING_EPSILON = 0.001;

export class EffectsManager {
  private enabled: boolean = true;
  private snapshots = new Map<string, UnitSnapshot>();
  private stamp: number = 0;
  private lastSimTime: number = -1;

  // Events detected in the most recent update. Arrays are reused across frames.
  readonly hits: HitEvent[] = [];
  readonly deaths: DeathEvent[] = [];

  // Simulation seconds elapsed since the previous update (0 while paused)
  private dt: number = 0;

  setEnabled(on: boolean): void {
    this.enabled = on;
    // Start from a clean state either way — stale snapshots would produce
    // a burst of fake deaths when effects are switched back on.
    this.reset();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // Call on restart: unit ids are reused across runs, so old snapshots must go.
  reset(): void {
    this.snapshots.clear();
    this.hits.length = 0;
    this.deaths.length = 0;
    this.lastSimTime = -1;
    this.dt = 0;
  }

  getDeltaTime(): number {
    return this.dt;
  }

  getFacing(id: string): 1 | -1 {
    return this.snapshots.get(id)?.facing ?? 1;
  }

  update(units: IUnit[], simTime: number): void {
    this.hits.length = 0;
    this.deaths.length = 0;
    if (!this.enabled) return;

    // Sim time went backwards → a new run started without reset() being called
    if (simTime < this.lastSimTime) this.reset();

    const firstFrame = this.lastSimTime < 0;
    this.dt = firstFrame ? 0 : simTime - this.lastSimTime;
    this.lastSimTime = simTime;

    // Paused: units cannot change, skip the diff
    if (!firstFrame && this.dt === 0) return;

    const stamp = ++this.stamp;

    for (const unit of units) {
      const snap = this.snapshots.get(unit.id);
      if (!snap) {
        // New unit (spawn or first frame) — no event
        this.snapshots.set(unit.id, {
          x: unit.position.x,
          y: unit.position.y,
          hp: unit.hp,
          unitType: unit.unitType,
          faction: unit.faction,
          facing: 1,
          stamp,
        });
        continue;
      }

      if (unit.hp < snap.hp) {
        this.hits.push({
          id: unit.id,
          x: unit.position.x,
          y: unit.position.y,
          damage: snap.hp - unit.hp,
          unitType: unit.unitType,
        });
      }

      const dx = unit.position.x - snap.x;
      if (dx > FACING_EPSILON) snap.facing = 1;
      else if (dx < -FACING_EPSILON) snap.facing = -1;

      snap.x = unit.position.x;
      snap.y = unit.position.y;
      snap.hp = unit.hp;
      snap.stamp = stamp;
    }

    // Units not seen this frame were removed by the engine → death
    for (const [id, snap] of this.snapshots) {
      if (snap.stamp === stamp) continue;
      this.deaths.push({
        id,
        x: snap.x,
        y: snap.y,
        unitType: snap.unitType,
        faction: snap.faction,
        facing: snap.facing,
      });
      this.snapshots.delete(id);
    }
  }

  // Debug counters for the overlay
  getTrackedCount(): number {
    return this.snapshots.size;
  }
}
