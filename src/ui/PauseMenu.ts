// The pause menu: a small panel over the run or the replay (the HUD stays in view), opened with
// Esc, the top bar's Menu or a result card's Menu. Continue (focused; Esc too), Restart, New
// battle (Match setup with the current choices, or the Sandbox after a Sandbox run), Title screen,
// Controls. What each does is UIController's (PauseActions); the run waits paused meanwhile.

export interface PauseActions {
  continueRun(): void;
  restart(): void;
  newBattle(): void;
  titleScreen(): void;
  controls(): void;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class PauseMenu {
  private el = $('pause-menu');

  constructor(actions: PauseActions) {
    $('pause-continue').addEventListener('click', () => actions.continueRun());
    $('pause-restart').addEventListener('click', () => actions.restart());
    $('pause-new').addEventListener('click', () => actions.newBattle());
    $('pause-title-screen').addEventListener('click', () => actions.titleScreen());
    $('pause-controls').addEventListener('click', () => actions.controls());
  }

  isOpen(): boolean {
    return !this.el.hidden;
  }

  // `what`: the run behind is a battle or a replay (the title says which)
  open(what: 'battle' | 'replay'): void {
    $('pause-title').textContent = what === 'replay' ? 'Replay paused' : 'Paused';
    this.el.dataset.run = what;
    this.el.hidden = false;
    document.body.dataset.screen = 'pause';
    $('pause-continue').focus();
  }

  close(): void {
    this.el.hidden = true;
  }

  // Back from the Controls screen: the focus where it was
  focusControls(): void {
    $('pause-controls').focus();
  }
}
