// Randomness for visual effects (blood spray, corpse tilt, walk phase). Effects must never use
// Math.random: the simulation draws from it, so every draw here would change the battle whenever
// FX are on. A small generator of their own (xorshift32), like the sound's.
let state = 0x9e3779b9;

export function fxRandom(): number {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state / 4294967296;
}
