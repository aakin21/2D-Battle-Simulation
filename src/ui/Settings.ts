import { SPEED_STEPS, SpeedStep } from '../engine/SimulationEngine';

// Per-browser conveniences kept in local storage (speed, debug, effects, bars, sound). Storage
// can be unavailable (private windows, blocked site data); settings then stay at their
// defaults for this session.

const LS_SPEED = 'sim_speed';
const LS_DEBUG = 'sim_debug';
const LS_EFFECTS = 'sim_effects';
const LS_BARS = 'sim_bars';
const LS_SOUND = 'sim_sound';

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// The saved speed, or null when none is saved (or it is not a speed step)
export function savedSpeed(): SpeedStep | null {
  const speed = readSetting(LS_SPEED);
  if (!speed) return null;
  const parsed = parseFloat(speed) as SpeedStep;
  return SPEED_STEPS.includes(parsed) ? parsed : null;
}

export function savedDebug(): boolean {
  return readSetting(LS_DEBUG) === 'true';
}

// Effects default to on; only an explicit 'false' turns them off
export function savedEffects(): boolean {
  return readSetting(LS_EFFECTS) !== 'false';
}

export function savedBars(): 'smart' | 'all' {
  return readSetting(LS_BARS) === 'all' ? 'all' : 'smart';
}

export function soundMuted(): boolean {
  return readSetting(LS_SOUND) === 'off';
}

export interface Settings {
  speed: number;
  debug: boolean;
  effects: boolean;
  bars: 'smart' | 'all';
  muted: boolean;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(LS_SPEED, s.speed.toString());
    localStorage.setItem(LS_DEBUG, s.debug.toString());
    localStorage.setItem(LS_EFFECTS, s.effects.toString());
    localStorage.setItem(LS_BARS, s.bars);
    localStorage.setItem(LS_SOUND, s.muted ? 'off' : 'on');
  } catch {
    // Storage unavailable: settings last for this session only
  }
}
