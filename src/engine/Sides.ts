import { Faction } from '../types/types';

// The two sides: West is Faction.FRIENDLY, East is Faction.ENEMY. Shared by the objectives, the
// AI layers and the UI, so the mapping is written once.

export type Side = 'west' | 'east';

export function opponent(f: Faction): Faction {
  return f === Faction.FRIENDLY ? Faction.ENEMY : Faction.FRIENDLY;
}

export function sideName(f: Faction): Side {
  return f === Faction.FRIENDLY ? 'west' : 'east';
}
