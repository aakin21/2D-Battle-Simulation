import type { Replay } from '../replay/Replay';
import { BundledReplay, listBundledReplays, loadBundledReplay } from '../replay/BundledReplays';
import { BATTLE_CONFIG } from '../types/types';
import { bridgeConnection } from '../ai/BridgeConnect';
import { openDialog, closeDialog, wireDialog } from './Dialog';
import { icon } from './icons';

// The title screen's choices: Quick battle (the main one), AI vs AI (Match setup: who commands each
// side is chosen there), Watch a recorded battle (the replays the site ships: none yet is "Coming
// soon", one plays at once, several open a short list; and Open a replay file…,
// ReplayController), Sandbox; the links Controls and About. The AI connections cards are
// Connections'. What each choice does is the front end's (TitleActions); this file wires the
// buttons, the art and the shipped replays.

export interface TitleActions {
  continueRun(): void;
  play(): void;
  aiVsAi(): void;
  sandbox(): void;
  controls(): void;
  watchReplay(replay: Replay): void;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class TitleScreen {
  private btnWatch = $('title-watch') as HTMLButtonElement;
  private watchDesc = $('watch-desc');
  private replaysDialog = $('replays-dialog');
  private aboutDialog = $('about-dialog');
  private bundled: BundledReplay[] = [];
  private loadingReplay = false;

  constructor(private actions: TitleActions) {
    this.setArt();
    wireDialog(this.aboutDialog);
    wireDialog(this.replaysDialog);
    $('menu-continue').addEventListener('click', () => actions.continueRun());
    $('title-play').addEventListener('click', () => actions.play());
    $('title-ai').addEventListener('click', () => actions.aiVsAi());
    $('title-sandbox').addEventListener('click', () => actions.sandbox());
    $('menu-instructions').addEventListener('click', () => actions.controls());
    $('title-about').addEventListener('click', () => openDialog(this.aboutDialog));
    this.btnWatch.addEventListener('click', () => this.watch());
    $('replays-list').addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (btn) void this.play(Number(btn.dataset.index));
    });
    void this.findReplays();
  }

  // The main action: Continue when a run waits behind, else Connect when the AI bridge waits for
  // its one click (a page opened with its address), else Play
  focusMain(): void {
    const cont = $('menu-continue');
    if (!cont.hidden) cont.focus();
    else if (bridgeConnection().invited) $('bridge-connect').focus();
    else $('title-play').focus();
  }

  // Continue is shown (and is the main action) while a run or a replay waits behind
  showContinue(run: 'battle' | 'replay' | null): void {
    $('menu-continue').hidden = run === null;
    $('title-play').classList.toggle('primary', run === null);
    if (run) $('title-screen').dataset.runBehind = run;
    else delete $('title-screen').dataset.runBehind;
    $('continue-desc').textContent =
      run === 'replay' ? 'Back to the recorded battle.' : 'Back to the battle.';
  }

  // --- Recorded battles ---

  private async findReplays(): Promise<void> {
    this.bundled = await listBundledReplays();
    this.showReplays();
  }

  // The Watch choice: the shipped battle, a list of them, or "coming soon" while there is none
  private showReplays(): void {
    const n = this.bundled.length;
    $('title-screen').dataset.replays = n === 0 ? 'none' : n === 1 ? 'one' : 'many';
    this.btnWatch.disabled = n === 0 || this.loadingReplay;
    this.watchDesc.textContent =
      n === 0
        ? 'Coming soon: battles between AI commanders, recorded.'
        : n === 1
          ? `${this.bundled[0].title ?? 'A battle between AI commanders'}. No setup.`
          : `${n} battles between AI commanders. No setup.`;
    $('replays-list').innerHTML = '';
    this.bundled.forEach((entry, i) => {
      const b = document.createElement('button');
      b.className = 'btn btn-quiet replay-item';
      b.dataset.index = String(i);
      b.textContent = entry.title ?? entry.file;
      $('replays-list').appendChild(b);
    });
  }

  private watch(): void {
    if (this.bundled.length === 1) void this.play(0);
    else if (this.bundled.length > 1)
      openDialog(this.replaysDialog, this.replaysDialog.querySelector<HTMLElement>('.replay-item'));
  }

  private async play(index: number): Promise<void> {
    const entry = this.bundled[index];
    if (!entry || this.loadingReplay) return;
    this.loadingReplay = true;
    this.showReplays();
    this.watchDesc.textContent = 'Loading the battle…';
    try {
      const replay = await loadBundledReplay(entry);
      closeDialog(this.replaysDialog);
      this.actions.watchReplay(replay);
    } catch (err) {
      window.alert(`This replay could not be opened: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.loadingReplay = false;
      this.showReplays();
    }
  }

  // --- Art ---

  // The sprites are menu.css's; the pixel icons and the numbers from the code are set here
  private setArt(): void {
    document.querySelector('.icon-watch')!.innerHTML = icon('play');
    document.querySelector('.icon-continue')!.innerHTML = icon('play');
    // "You command the West army's 3 heroes"
    $('play-desc').textContent =
      `You command the West army's ${BATTLE_CONFIG.heroesPerSide} heroes against the built-in rules, on a random map. Starts at once.`;
  }
}
