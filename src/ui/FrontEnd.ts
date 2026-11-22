import type { Replay } from '../replay/Replay';
import { AttractBattle } from './Attract';
import type { MainMenu, MenuScreen } from './MainMenu';
import { TitleScreen } from './TitleScreen';

// The front end: full screen over the attract battle (Attract.ts), with the page's HUD hidden
// behind it. Three screens: the title screen (TitleScreen.ts), Match setup and the Sandbox
// (MainMenu's settings). One screen shows at a time; a new one replaces the old at once and comes
// in with a short rise (front.css), and the focus goes to its main action (title: Continue when
// a run waits behind, else Battle; Match setup and the Sandbox: Start). Back and Esc go back one
// screen: Match setup and the Sandbox to the title screen, or to the pause menu when they were
// opened from it (New battle), as is the title screen (Main menu). Match setup is opened by Battle
// or New battle, with the choices as they were left (the first time: you command West against
// the rules, so Start plays at once).
//
// At page load the title screen shows (a returning visitor too: it is one click to play), or the
// screen the user left for openrouter.ai, with the choices put back.

export interface FrontEndHost {
  start(): void; // Start in Match setup or the Sandbox (MainMenu.readStart)
  continueRun(): void; // back to the run or replay that waits behind
  backToPause(): void; // back to the pause menu the front end was opened from
  watchReplay(replay: Replay): void;
  openControls(): void;
  runBehind(): 'battle' | 'replay' | null;
  setMainDrawing(on: boolean): void; // the page's own view is not drawn while it is covered
}

type From = 'title' | 'pause';
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const SCREEN_EL: Record<MenuScreen, string> = {
  title: 'title-screen',
  setup: 'setup-screen',
  sandbox: 'sandbox-screen',
};

export class FrontEnd {
  private el = $('main-menu');
  private current: MenuScreen = 'title';
  private from: From = 'title'; // where Back goes from Match setup or the Sandbox
  private origin: From = 'title'; // the front end was opened from the pause menu, or not
  private title: TitleScreen;
  attract: AttractBattle | null = null;

  constructor(
    private menu: MainMenu,
    private host: FrontEndHost
  ) {
    this.title = new TitleScreen({
      continueRun: () => host.continueRun(),
      battle: () => this.show('setup', 'title'),
      sandbox: () => this.show('sandbox', 'title'),
      controls: () => host.openControls(),
      watchReplay: (replay) => host.watchReplay(replay),
    });
    $('setup-back').addEventListener('click', () => this.back());
    $('sandbox-back').addEventListener('click', () => this.back());
    $('menu-start').addEventListener('click', () => {
      menu.mode = 'battle';
      host.start();
    });
    $('sandbox-start').addEventListener('click', () => {
      menu.mode = 'sandbox';
      host.start();
    });
    this.open(menu.returnScreen ?? 'title', 'title');
  }

  isOpen(): boolean {
    return !this.el.hidden;
  }

  // Shows the front end with `screen` (Back from it goes to `from`)
  open(screen: MenuScreen, from: From): void {
    const wasOpen = this.isOpen();
    this.origin = from;
    this.el.hidden = false;
    document.body.classList.add('front-open');
    this.host.setMainDrawing(false);
    this.el.classList.toggle('fade-in', !wasOpen);
    this.title.showContinue(this.host.runBehind());
    this.startAttract();
    this.show(screen, from);
  }

  // The attract battle behind the screens (a page without canvas drawing, e.g. the tests' fake
  // DOM, has none; a failure to set it up leaves the plain background)
  private startAttract(): void {
    const canvas = $('attract-canvas');
    if (this.attract || typeof HTMLCanvasElement === 'undefined') return;
    if (!(canvas instanceof HTMLCanvasElement)) return;
    try {
      this.attract = new AttractBattle(canvas, (state) => (this.el.dataset.attract = state));
    } catch (err) {
      console.warn('No attract battle:', err);
      this.attract = null;
    }
  }

  // Hides the front end: the attract battle is gone before anything else runs
  close(): void {
    this.attract?.dispose();
    this.attract = null;
    this.el.hidden = true;
    this.el.classList.remove('fade-in');
    document.body.classList.remove('front-open');
    this.host.setMainDrawing(true);
  }

  // Esc and the Back buttons: one screen back (on the title screen: back to the pause menu it was
  // opened from, while the run still waits behind)
  back(): void {
    if (this.current !== 'title' && this.from === 'title') this.show('title', 'title');
    else if (this.origin === 'pause' && this.host.runBehind()) {
      this.close();
      this.host.backToPause();
    }
  }

  show(screen: MenuScreen, from: From, focus = true): void {
    const changed = screen !== this.current;
    this.current = screen;
    this.from = from;
    this.menu.screen = screen;
    if (screen === 'setup') this.menu.mode = 'battle';
    if (screen === 'sandbox') this.menu.mode = 'sandbox';
    for (const [s, id] of Object.entries(SCREEN_EL)) {
      const el = $(id);
      el.hidden = s !== screen;
      if (s === screen && changed) {
        // Come in again (the CSS animation restarts with the class)
        el.classList.remove('enter');
        void el.offsetWidth;
        el.classList.add('enter');
      }
    }
    this.el.dataset.screen = screen;
    document.body.dataset.screen = screen;
    // Match setup follows the choices and connections; the page's own AI server is asked once
    if (screen === 'setup') this.menu.setup.opened();
    if (focus) this.focusMain();
  }

  private focusMain(): void {
    if (this.current === 'title') this.title.focusMain();
    else $(this.current === 'setup' ? 'menu-start' : 'sandbox-start').focus();
  }
}
