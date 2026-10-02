import warriorUrl from '../assets/sprites/warrior_knight.png';
import berserkerUrl from '../assets/sprites/berserker_lion.png';

// "Building simulation" screen shown after pressing Start. The simulation is set up
// immediately and kept paused behind the overlay; the screen walks through the setup
// steps, then fades out and the battle starts. Clicking the overlay skips it.

const STEPS = [
  'Generating terrain',
  'Deploying warriors',
  'Preparing berserker waves',
  'Calculating paths',
  'Ready',
];
const DURATION_MS = 3500;
const FADE_MS = 400; // matches the CSS opacity transition

export class LoadingScreen {
  private el: HTMLElement;
  private elStep: HTMLElement;
  private elFill: HTMLElement;
  private active: boolean = false;
  private skip: (() => void) | null = null;

  constructor() {
    this.el = document.getElementById('loading-overlay')!;
    this.elStep = document.getElementById('loading-step')!;
    this.elFill = document.getElementById('loading-fill')!;
    // Sprite URLs are hashed by the bundler, so they are set from code
    document.getElementById('loading-warrior')!.style.backgroundImage = `url(${warriorUrl})`;
    document.getElementById('loading-berserker')!.style.backgroundImage = `url(${berserkerUrl})`;
    this.el.addEventListener('click', () => this.skip?.());
  }

  isActive(): boolean {
    return this.active;
  }

  // Shows the screen, steps through the messages, fades out. Resolves when hidden.
  async run(): Promise<void> {
    this.active = true;
    this.el.classList.remove('fading');
    this.el.style.display = 'flex';
    this.setProgress(0, STEPS[0]);

    let skipped = false;
    const skipPromise = new Promise<void>((resolve) => {
      this.skip = () => {
        skipped = true;
        resolve();
      };
    });

    const stepMs = DURATION_MS / STEPS.length;
    for (let i = 0; i < STEPS.length && !skipped; i++) {
      this.setProgress((i + 1) / STEPS.length, STEPS[i]);
      await Promise.race([wait(stepMs), skipPromise]);
    }
    this.skip = null;

    this.setProgress(1, STEPS[STEPS.length - 1]);
    this.el.classList.add('fading');
    await wait(FADE_MS);
    this.el.style.display = 'none';
    this.active = false;
  }

  private setProgress(ratio: number, step: string): void {
    this.elFill.style.width = `${Math.round(ratio * 100)}%`;
    this.elStep.textContent = step === 'Ready' ? 'Ready' : `${step}…`;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
