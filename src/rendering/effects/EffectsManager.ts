import { IUnit, UnitType, Faction, Camera } from '../../types/types';
import { Corpses } from './Corpses';
import { Blood } from './Blood';
import { StatusIcons } from './StatusIcons';

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

// Hit flash length in real milliseconds. Real time (not sim time) so the flash
// stays visible at 4x speed; no new hits occur while paused anyway.
const FLASH_MS = 90;

export class EffectsManager {
  private enabled: boolean = true;
  private snapshots = new Map<string, UnitSnapshot>();
  private stamp: number = 0;
  private lastSimTime: number = -1;

  private corpses = new Corpses();
  private blood = new Blood();
  private statusIcons = new StatusIcons();

  // Unit id → real time (ms) at which its hit flash ends
  private flashes = new Map<string, number>();

  // Events detected in the most recent update. Arrays are reused across frames.
  readonly hits: HitEvent[] = [];
  readonly deaths: DeathEvent[] = [];

  // Simulation seconds elapsed since the previous update (0 while paused)
  private dt: number = 0;

  // Pre-builds sprites and layers and uploads them to the GPU by drawing them once
  // on warmTarget (needs a DOM). Without this, the first death costs a ~15 ms frame.
  prepare(warmTarget: CanvasRenderingContext2D): void {
    this.corpses.prepare(warmTarget);
    this.blood.prepare(warmTarget);
    this.statusIcons.prepare(warmTarget);
  }

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
    this.flashes.clear();
    this.corpses.clear();
    this.blood.clear();
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

  hasFlashes(): boolean {
    return this.flashes.size > 0;
  }

  // True while the unit's hit flash is active. Expired entries are dropped here,
  // so the map only holds units that were hit in the last FLASH_MS.
  isFlashing(id: string, now: number): boolean {
    const until = this.flashes.get(id);
    if (until === undefined) return false;
    if (now < until) return true;
    this.flashes.delete(id);
    return false;
  }

  update(units: IUnit[], simTime: number, now: number = performance.now()): void {
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

    // Drop expired flashes, including those of off-screen units that are never drawn
    for (const [id, until] of this.flashes) {
      if (now >= until) this.flashes.delete(id);
    }

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
        this.flashes.set(unit.id, now + FLASH_MS);
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
      this.flashes.delete(id);
    }

    this.corpses.update(this.dt);
    this.blood.update(this.dt);
    for (const h of this.hits) this.blood.spawnHit(h);
    for (const d of this.deaths) {
      this.corpses.spawn(d);
      this.blood.spawnPool(d, simTime);
    }
  }

  // Effects that lie on the ground, drawn after terrain and before units
  drawUnderUnits(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    width: number,
    height: number
  ): void {
    if (!this.enabled) return;
    // Blood pools first so corpses lie on top of them
    this.blood.drawPools(ctx, camera, width, height, this.lastSimTime);
    this.corpses.draw(ctx, camera, width, height);
  }

  // Effects in the air, drawn after units
  drawOverUnits(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    width: number,
    height: number
  ): void {
    if (!this.enabled) return;
    this.blood.drawDrops(ctx, camera, width, height);
  }

  // UI-like markers drawn last, above units and their HP bars
  drawOverlay(
    ctx: CanvasRenderingContext2D,
    units: IUnit[],
    camera: Camera,
    width: number,
    height: number
  ): void {
    if (!this.enabled) return;
    this.statusIcons.draw(ctx, units, camera, width, height, Math.max(0, this.lastSimTime));
  }

  // Debug counters for the overlay
  getTrackedCount(): number {
    return this.snapshots.size;
  }

  getCorpseCount(): number {
    return this.corpses.size;
  }

  getDropCount(): number {
    return this.blood.dropCount;
  }

  getBloodPoolCount(): number {
    return this.blood.countPools(this.lastSimTime);
  }
}
