// Pre-rendered effect sprites. Drawing a small canvas with drawImage is a fast path
// in Canvas 2D; filling thousands of rotated paths or ellipses every frame is not
// (measured: ~4–8 ms per frame for 1500 shapes vs ~1.5 ms as sprites).

// Corpse sprites are rendered at this square side and scaled down when drawn
export const CORPSE_SPRITE_SIDE = 96;
// Canvas side that fits the square at any rotation (side·√2, rounded up)
export const CORPSE_SPRITE_CANVAS = Math.ceil(CORPSE_SPRITE_SIDE * Math.SQRT2) + 2;

// Final corpse tilts: 20°–70° to either side
export const CORPSE_TILTS: number[] = [20, 37, 53, 70, -20, -37, -53, -70].map(
  (d) => (d * Math.PI) / 180
);

export function makeCorpseSprites(colors: string[]): HTMLCanvasElement[][] {
  // [colorIndex][tiltIndex]
  return colors.map((color) =>
    CORPSE_TILTS.map((tilt) => {
      const c = document.createElement('canvas');
      c.width = c.height = CORPSE_SPRITE_CANVAS;
      const ctx = c.getContext('2d')!;
      ctx.translate(CORPSE_SPRITE_CANVAS / 2, CORPSE_SPRITE_CANVAS / 2);
      ctx.rotate(tilt);
      ctx.fillStyle = color;
      ctx.fillRect(
        -CORPSE_SPRITE_SIDE / 2,
        -CORPSE_SPRITE_SIDE / 2,
        CORPSE_SPRITE_SIDE,
        CORPSE_SPRITE_SIDE
      );
      return c;
    })
  );
}

// Blood pool sprites: an ellipse with radii (rx, ry) = (1, ryRatio) × POOL_SPRITE_RX,
// in a few rotations. Drawn scaled; the sprite canvas is square.
export const POOL_SPRITE_RX = 64;
export const POOL_SPRITE_CANVAS = POOL_SPRITE_RX * 2 + 4;
export const POOL_ROTATIONS = 6;

export function makePoolSprites(color: string, ryRatio: number): HTMLCanvasElement[] {
  const sprites: HTMLCanvasElement[] = [];
  for (let i = 0; i < POOL_ROTATIONS; i++) {
    const c = document.createElement('canvas');
    c.width = c.height = POOL_SPRITE_CANVAS;
    const ctx = c.getContext('2d')!;
    const mid = POOL_SPRITE_CANVAS / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(
      mid,
      mid,
      POOL_SPRITE_RX,
      POOL_SPRITE_RX * ryRatio,
      (i * Math.PI) / POOL_ROTATIONS,
      0,
      Math.PI * 2
    );
    ctx.fill();
    sprites.push(c);
  }
  return sprites;
}
