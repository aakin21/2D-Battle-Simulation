import { Position } from '../types/types';

// Random patrol destinations shared by a group (classic berserker waves) or by one
// rule-based hero. A destination is kept for 15–30 s, then a new one is picked.
export class GroupPatrol {
  private entries = new Map<string, { dest: Position; expiry: number }>();

  destination(groupId: string, pos: Position, elapsed: number): Position {
    const entry = this.entries.get(groupId);
    if (entry && elapsed < entry.expiry) return entry.dest;

    const angle = Math.random() * Math.PI * 2;
    const d = 20 + Math.random() * 30;
    const dest: Position = {
      x: Math.round(Math.max(5, Math.min(144, pos.x + Math.cos(angle) * d))),
      y: Math.round(Math.max(5, Math.min(144, pos.y + Math.sin(angle) * d))),
    };
    this.entries.set(groupId, { dest, expiry: elapsed + 15 + Math.random() * 15 });
    return dest;
  }

  // Drop a destination early (reached, or unreachable) so a new one is picked.
  forget(groupId: string): void {
    this.entries.delete(groupId);
  }

  clear(): void {
    this.entries.clear();
  }
}
