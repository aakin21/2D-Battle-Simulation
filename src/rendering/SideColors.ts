// The two sides' colours by Faction (west gold, east blue), as in the unit sprites and the HUD.
// Shared by the main view and the minimap.
export const SIDE_HEX = ['#ffd23f', '#6aa8ff'];
// The same colours as "r, g, b", for rgb() and rgba()
export const SIDE_RGB = ['255, 210, 63', '106, 168, 255'];
// Battle mode: enemy heroes (and their task points) stand out from blue berserkers
export const ENEMY_HERO_COLOR = '#00E5FF';

// '#rrggbb' as [r, g, b] (0–255), for colours that are painted into pixel data
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
