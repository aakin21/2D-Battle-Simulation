import type { HeroCommand } from '../types/types';
import type { Side } from '../engine/Sides';
import { positionToSubsector } from '../engine/Sectors';

// Small text helpers shared by the HUD, the AI panels and the request log.

export const SIDE_NAME: Record<Side, string> = { west: 'West', east: 'East' };

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Seconds as m:ss
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// A hero's order as the UI shows it (the AI layers describe orders in their own words)
export function describeCommand(c: HeroCommand): string {
  switch (c.type) {
    case 'move':
      return `move to ${positionToSubsector(c.target)}`;
    case 'hold':
      return `hold in ${positionToSubsector(c.at)}`;
    case 'retreat':
      return 'retreat a short way';
    case 'attack':
      return 'attack nearest enemy';
    case 'attackHero':
      return `attack enemy hero ${c.heroIndex}`;
    case 'regroup':
      return 'regroup strays';
    case 'attackBase':
      return 'attack the enemy base';
    case 'continueLlm':
      return "follow the LLM's order";
  }
}
