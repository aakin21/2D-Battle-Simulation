// Fixed-capacity object pool for short-lived effects (particles, flashes).
// Objects are preallocated once and recycled, so spawning effects never allocates
// during the frame loop. When full, new spawns are dropped instead of growing.
export class Pool<T> {
  private items: T[];
  private active: number = 0;

  constructor(capacity: number, factory: () => T) {
    this.items = Array.from({ length: capacity }, factory);
  }

  // Returns a recycled object, or null when the pool is at capacity.
  spawn(): T | null {
    if (this.active >= this.items.length) return null;
    return this.items[this.active++];
  }

  // Calls fn on every active item; items for which fn returns false are released.
  // Release is swap-with-last, so iteration order is not stable.
  update(fn: (item: T) => boolean): void {
    let i = 0;
    while (i < this.active) {
      if (fn(this.items[i])) {
        i++;
      } else {
        this.active--;
        const tmp = this.items[i];
        this.items[i] = this.items[this.active];
        this.items[this.active] = tmp;
      }
    }
  }

  forEach(fn: (item: T) => void): void {
    for (let i = 0; i < this.active; i++) fn(this.items[i]);
  }

  clear(): void {
    this.active = 0;
  }

  get size(): number {
    return this.active;
  }
}

// Fixed-capacity ring buffer for long-lived marks (blood decals).
// When full, the oldest entry is overwritten.
export class RingBuffer<T> {
  private items: T[];
  private head: number = 0;
  private count: number = 0;

  constructor(capacity: number, factory: () => T) {
    this.items = Array.from({ length: capacity }, factory);
  }

  // Returns the slot to fill — a fresh one, or the oldest when full.
  push(): T {
    const item = this.items[this.head];
    this.head = (this.head + 1) % this.items.length;
    if (this.count < this.items.length) this.count++;
    return item;
  }

  forEach(fn: (item: T) => void): void {
    const cap = this.items.length;
    const start = (this.head - this.count + cap) % cap;
    for (let i = 0; i < this.count; i++) fn(this.items[(start + i) % cap]);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}
