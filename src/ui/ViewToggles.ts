import type { SimulationEngine } from '../engine/SimulationEngine';
import type { Renderer } from '../rendering/Renderer';
import type { Sound } from './Sound';
import { icon } from './icons';
import { savedBars, savedDebug, savedEffects, savedSpeed, saveSettings } from './Settings';

// The top bar's view toggles (FX, Bars, Sound, Debug) and the per-browser settings they keep
// with the run speed (Settings.ts): read once at page load, saved on every change.
export class ViewToggles {
  private debugMode = false;
  private elBtnDebug = document.getElementById('btn-debug') as HTMLButtonElement;
  private elBtnEffects = document.getElementById('btn-effects') as HTMLButtonElement;
  private elBtnBars = document.getElementById('btn-bars') as HTMLButtonElement;
  private elBtnSound = document.getElementById('btn-sound') as HTMLButtonElement;

  constructor(
    private engine: SimulationEngine,
    private renderer: Renderer,
    private sound: Sound
  ) {}

  // The sound button: mute or unmute
  wireSound(): void {
    this.elBtnSound.addEventListener('click', () => {
      this.sound.setMuted(!this.sound.isMuted());
      this.updateSoundButton();
      this.save();
    });
    this.updateSoundButton();
  }

  // Applies the saved settings; true when a saved speed was set on the engine
  load(): boolean {
    const speed = savedSpeed();
    if (speed !== null) this.engine.setSpeed(speed);

    if (savedDebug()) {
      this.debugMode = true;
      this.renderer.setDebugMode(true);
      this.elBtnDebug.classList.add('on');
    }

    this.renderer.setEffectsEnabled(savedEffects());
    this.updateEffectsButton();
    this.renderer.setBarsMode(savedBars());
    this.updateBarsButton();
    return speed !== null;
  }

  // Debug, FX and Bars
  wire(): void {
    this.elBtnDebug.addEventListener('click', () => {
      this.debugMode = !this.debugMode;
      this.renderer.setDebugMode(this.debugMode);
      this.elBtnDebug.classList.toggle('on', this.debugMode);
      this.save();
    });

    this.elBtnEffects.addEventListener('click', () => {
      this.renderer.setEffectsEnabled(!this.renderer.isEffectsEnabled());
      this.updateEffectsButton();
      this.save();
    });

    this.elBtnBars.addEventListener('click', () => {
      this.renderer.setBarsMode(this.renderer.getBarsMode() === 'smart' ? 'all' : 'smart');
      this.updateBarsButton();
      this.save();
    });
  }

  save(): void {
    saveSettings({
      speed: this.engine.getSpeed(),
      debug: this.debugMode,
      effects: this.renderer.isEffectsEnabled(),
      bars: this.renderer.getBarsMode(),
      muted: this.sound.isMuted(),
    });
  }

  private updateSoundButton(): void {
    const muted = this.sound.isMuted();
    this.elBtnSound.innerHTML = icon(muted ? 'soundOff' : 'soundOn');
    this.elBtnSound.title = muted
      ? 'Sound is off (click to turn on)'
      : 'Sound is on (click to mute)';
  }

  private updateBarsButton(): void {
    const all = this.renderer.getBarsMode() === 'all';
    this.elBtnBars.classList.toggle('on', all);
    this.elBtnBars.title = all
      ? 'HP and courage bars over every unit (click: only where something happens)'
      : 'Bars only over units that are hurt, fighting, fleeing or resting, heroes and the selected unit (click: over every unit)';
  }

  private updateEffectsButton(): void {
    const on = this.renderer.isEffectsEnabled();
    this.elBtnEffects.classList.toggle('on', on);
    this.elBtnEffects.title = on
      ? 'Visual effects and sprites are on (click for the original squares)'
      : 'Visual effects are off: original squares (click to turn on)';
  }
}
