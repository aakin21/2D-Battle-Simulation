import slash1Url from '../assets/sound/slash1.wav';
import slash2Url from '../assets/sound/slash2.wav';
import hitUrl from '../assets/sound/hit.wav';
import deathUrl from '../assets/sound/death.wav';
import orderUrl from '../assets/sound/order.wav';
import clickUrl from '../assets/sound/click.wav';
import startUrl from '../assets/sound/start.wav';
import victoryUrl from '../assets/sound/victory.wav';
import defeatUrl from '../assets/sound/defeat.wav';

// Sound effects from the Ninja Adventure pack (CC0), played with the Web Audio API.
// As in strategy games, a crowded battle must not become a wall of noise: only what is on
// screen makes a sound, each kind of sound has a cooldown, at most a few play at once, and
// each one gets a slightly different pitch. Mute is saved per browser.

export type SoundName =
  | 'slash1'
  | 'slash2'
  | 'hit'
  | 'death'
  | 'order'
  | 'click'
  | 'start'
  | 'victory'
  | 'defeat';

const URLS: Record<SoundName, string> = {
  slash1: slash1Url,
  slash2: slash2Url,
  hit: hitUrl,
  death: deathUrl,
  order: orderUrl,
  click: clickUrl,
  start: startUrl,
  victory: victoryUrl,
  defeat: defeatUrl,
};

const VOLUME: Record<SoundName, number> = {
  slash1: 0.3,
  slash2: 0.3,
  hit: 0.3,
  death: 0.45,
  order: 0.5,
  click: 0.25,
  start: 0.5,
  victory: 0.6,
  defeat: 0.6,
};

const MASTER_VOLUME = 0.6;
const MAX_VOICES = 8;
const HIT_COOLDOWN_MS = 75;
const DEATH_COOLDOWN_MS = 120;
const PITCH_SPREAD = 0.12; // ±6%
const COMBAT_SOUNDS: SoundName[] = ['slash1', 'slash2', 'hit'];

type AudioContextClass = typeof AudioContext;

export class Sound {
  private ctx: AudioContext | null = null;
  private unavailable = false;
  private master: GainNode | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private voices = 0;
  private lastHit = 0;
  private lastDeath = 0;
  // Small local generator for pitch and choice, so audio never uses the simulation's
  // Math.random
  private seed = 0x2545f491;

  constructor(private muted: boolean) {}

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!muted) this.unlock();
  }

  // Browsers only start audio after a user gesture, so this is called from clicks and keys.
  // The first call creates the audio context and loads the sounds.
  unlock(): void {
    if (this.muted || this.unavailable) return;
    if (!this.ctx) {
      const Ctx: AudioContextClass | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
      if (!Ctx) return;
      try {
        this.ctx = new Ctx();
      } catch (err) {
        // The browser refused an audio context (e.g. too many open): this page stays silent
        console.warn('Sound unavailable:', err);
        this.unavailable = true;
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = MASTER_VOLUME;
      this.master.connect(this.ctx.destination);
      void this.load(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  private async load(ctx: AudioContext): Promise<void> {
    await Promise.all(
      (Object.keys(URLS) as SoundName[]).map(async (name) => {
        try {
          const data = await (await fetch(URLS[name])).arrayBuffer();
          this.buffers.set(name, await ctx.decodeAudioData(data));
        } catch (err) {
          console.warn(`Sound ${name} not loaded:`, err);
        }
      })
    );
  }

  private random(): number {
    // xorshift32
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  play(name: SoundName, volume = 1): void {
    if (this.muted || !this.ctx || !this.master || this.ctx.state !== 'running') return;
    const buffer = this.buffers.get(name);
    if (!buffer || this.voices >= MAX_VOICES) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 1 + (this.random() - 0.5) * PITCH_SPREAD;
    const gain = this.ctx.createGain();
    gain.gain.value = VOLUME[name] * volume;
    source.connect(gain);
    gain.connect(this.master);
    this.voices++;
    source.onended = () => {
      this.voices--;
      gain.disconnect();
    };
    source.start();
  }

  // Combat sounds for the hits and deaths seen on screen this frame. loudness (0–1) follows
  // the zoom: a battle seen from far away is quieter than one seen up close.
  battle(hits: number, deaths: number, loudness: number): void {
    if (this.muted || !this.ctx) return;
    const now = performance.now();
    if (hits > 0 && now - this.lastHit >= HIT_COOLDOWN_MS) {
      this.lastHit = now;
      const name = COMBAT_SOUNDS[Math.floor(this.random() * COMBAT_SOUNDS.length)];
      this.play(name, loudness * Math.min(1, 0.6 + hits * 0.05));
    }
    if (deaths > 0 && now - this.lastDeath >= DEATH_COOLDOWN_MS) {
      this.lastDeath = now;
      this.play('death', loudness * Math.min(1, 0.7 + deaths * 0.05));
    }
  }
}
