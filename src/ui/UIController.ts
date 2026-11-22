import { SimulationEngine } from '../engine/SimulationEngine';
import { StateManager } from '../state/StateManager';
import { Renderer } from '../rendering/Renderer';
import { MinimapRenderer } from '../rendering/MinimapRenderer';
import { InputHandler } from './InputHandler';
import {
  Faction,
  SimConfig,
  DEFAULT_CONFIG,
  SideAI,
  LlmModel,
  TacticalModel,
} from '../types/types';
import { JevController } from '../ai/JevController';
import { TACTICAL_NAME } from '../ai/Models';
import { LlmController } from '../ai/LlmController';
import { AIController, MatchResult } from '../engine/SimulationEngine';
import { LoadingScreen } from './LoadingScreen';
import { Tour } from './Tour';
import { Hud } from './Hud';
import { AiPanel } from './AiPanel';
import { AiSides, MatchLog } from './MatchLog';
import { Sound } from './Sound';
import { MainMenu } from './MainMenu';
import { CanvasInteraction } from './CanvasInteraction';
import { soundMuted } from './Settings';
import { icon } from './icons';
import { ReplayController } from './ReplayController';
import { ViewToggles } from './ViewToggles';
import { FrontEnd } from './FrontEnd';
import { PauseMenu } from './PauseMenu';
import { dialogOpen } from './Dialog';
import { HintMode, Hints } from './Hints';
import keySpaceUrl from '../assets/ui/keys/Space.png';
import keyRUrl from '../assets/ui/keys/R.png';
import keyShiftUrl from '../assets/ui/keys/Shift.png';
import keyEscapeUrl from '../assets/ui/keys/Escape.png';
import mouseLeftUrl from '../assets/ui/keys/MouseButtonLeft.png';
import mouseRightUrl from '../assets/ui/keys/MouseButtonRight.png';
import mouseWheelUrl from '../assets/ui/keys/MouseWheelUp.png';

// Rows of the Controls screen: key images or key names, then what they do
const HELP: Array<[string[], string]> = [
  [[mouseLeftUrl], 'Select a unit'],
  [[mouseRightUrl], 'Order the selected hero to a point'],
  [[mouseLeftUrl, 'drag'], 'Count the units in an area (zoomed out) or pan (zoomed in)'],
  [[keyShiftUrl, mouseLeftUrl], 'Pan the map'],
  [[mouseWheelUrl], 'Zoom'],
  [[keySpaceUrl], 'Pause / resume'],
  [['+', '−'], 'Faster / slower'],
  [[keyRUrl], 'Restart'],
  [[keyEscapeUrl], 'Menu'],
];

export class UIController {
  private engine: SimulationEngine;
  private stateManager: StateManager;
  private renderer: Renderer;
  private minimapRenderer: MinimapRenderer;
  private inputHandler: InputHandler;
  private loading = new LoadingScreen();
  // The menus' guided tour (the "?" buttons); it handles its own buttons and keys
  readonly tour = new Tour();
  private hud: Hud;
  private aiPanel = new AiPanel();
  private sound: Sound;
  private menu: MainMenu;
  private canvas: CanvasInteraction;
  private toggles: ViewToggles;
  private replays: ReplayController;
  private front: FrontEnd;
  private pause: PauseMenu;
  private hints: Hints;
  private aiSides: AiSides = { west: {}, east: {} };
  private matchLog: MatchLog | null = null;
  // Which map the current run uses, for the match log: random, fixed or "saved: <name>"
  private mapChoice: string = 'random';
  private lastConfig: SimConfig = DEFAULT_CONFIG;
  // A run started from the menu exists (the menu can go back to it)
  private runStarted: boolean = false;
  // Which settings the last run came from: New battle opens them again
  private lastMode: 'battle' | 'sandbox' = 'battle';
  // The pause menu or the front end is over the run or replay; how they were before it opened
  private inMenu: boolean = false;
  private pausedBeforeMenu: boolean = false;
  private replayPlayingBeforeMenu: boolean = false;
  private shownPaused: boolean | null = null;

  private elBtnPause: HTMLButtonElement;
  private elSpeedDisplay: HTMLElement;
  private elInstructions: HTMLElement;
  private elCanvasArea: HTMLElement;

  constructor(
    engine: SimulationEngine,
    stateManager: StateManager,
    renderer: Renderer,
    minimapRenderer: MinimapRenderer
  ) {
    this.engine = engine;
    this.stateManager = stateManager;
    this.renderer = renderer;
    this.minimapRenderer = minimapRenderer;
    this.inputHandler = new InputHandler('battleCanvas');
    this.hud = new Hud(engine, stateManager, renderer);
    this.sound = new Sound(soundMuted());
    this.canvas = new CanvasInteraction(
      engine,
      stateManager,
      renderer,
      this.hud,
      this.sound,
      this.inputHandler
    );
    this.toggles = new ViewToggles(engine, renderer, this.sound);
    this.replays = new ReplayController(
      engine,
      renderer,
      this.canvas,
      this.hud,
      this.aiPanel,
      this.loading,
      {
        resetView: () => this.resetView(),
        closeMenu: () => this.continueRun(),
        showRunState: () => {
          this.updatePauseButton();
          this.updateSpeedDisplay();
        },
        // Without a run there is nothing behind the replay but the page's idle default
        // battlefield: back to the title screen
        afterExit: () => {
          if (!this.runStarted) this.front.open('title', 'title');
        },
      }
    );

    this.elBtnPause = document.getElementById('btn-pause') as HTMLButtonElement;
    this.elSpeedDisplay = document.getElementById('speed-display')!;
    this.elInstructions = document.getElementById('instructions-overlay')!;
    this.elCanvasArea = document.getElementById('canvas-area')!;

    this.setIcons();
    this.wireSound();
    this.buildHelp();
    this.watchCanvasSize();
    if (this.toggles.load()) this.updateSpeedDisplay();
    this.menu = new MainMenu();
    this.pause = new PauseMenu({
      continueRun: () => this.continueRun(),
      restart: () => {
        this.continueRun();
        this.doRestart();
      },
      newBattle: () => {
        this.pause.close();
        this.front.open(this.lastMode === 'battle' ? 'setup' : 'sandbox', 'pause');
      },
      titleScreen: () => {
        this.pause.close();
        this.front.open('title', 'pause');
      },
      controls: () => this.openControls(),
    });
    this.front = new FrontEnd(this.menu, {
      start: () => void this.start(),
      continueRun: () => this.continueRun(),
      backToPause: () => this.openPause(),
      watchReplay: (replay) => {
        this.continueRun();
        this.replays.watch(replay);
      },
      openControls: () => this.openControls(),
      runBehind: () => this.runBehind(),
      setMainDrawing: (on) => this.setMainDrawing(on),
    });
    this.hints = new Hints(stateManager, renderer, {
      mode: () => this.hintMode(),
      replaying: () => this.replays.player !== null,
    });
    this.wireMenuButtons();
    this.engine.setOnMatchEnd((r) => this.showMatchResult(r));
    this.engine.setOnStep(() => this.replays.sampleFrame());
    this.replays.wire();
    this.engine.setOnError((message) => this.showError(message));
    this.wireButtonEvents();
    this.wireInputEvents();
    this.startUIRefresh();
  }

  // --- Page setup ---

  private setIcons(): void {
    const set = (id: string, svg: string) => (document.getElementById(id)!.innerHTML = svg);
    set('btn-slower', icon('slower'));
    set('btn-faster', icon('faster'));
    set('btn-restart', icon('restart'));
    set('btn-save-map', icon('save'));
    set('btn-help', icon('help'));
    this.updatePauseButton();
  }

  private updatePauseButton(): void {
    const player = this.replays.player;
    const paused = player ? !player.isPlaying() : this.engine.isPaused();
    if (paused === this.shownPaused) return;
    this.shownPaused = paused;
    this.elBtnPause.innerHTML = icon(paused ? 'play' : 'pause');
    this.elBtnPause.title = paused ? 'Resume (Space)' : 'Pause (Space)';
  }

  private wireSound(): void {
    this.renderer.setBattleSound((hits, deaths, loudness) =>
      this.sound.battle(hits, deaths, loudness)
    );
    // Audio may only start after a user gesture
    const unlock = () => this.sound.unlock();
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
    // A soft click for buttons in the menus and the top bar
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.btn, .seg button, .icon-btn, .choice, .link-btn'))
        this.sound.play('click');
    });
    this.toggles.wireSound();
  }

  private buildHelp(): void {
    const table = document.getElementById('help-table')!;
    table.innerHTML = HELP.map(([keys, what]) => {
      const shown = keys
        .map((k) =>
          k.length > 2 && k !== 'drag'
            ? `<img src="${k}" alt="">`
            : `<span class="key-text">${k}</span>`
        )
        .join('');
      return `<tr><td>${shown}</td><td>${what}</td></tr>`;
    }).join('');
  }

  // The battlefield canvas fills its area; the renderer and minimap follow its size.
  private watchCanvasSize(): void {
    const apply = () => {
      const w = this.elCanvasArea.clientWidth;
      const h = this.elCanvasArea.clientHeight;
      if (w <= 0 || h <= 0) return;
      this.renderer.resize(w, h);
      const view = this.renderer.getViewSize();
      this.minimapRenderer.setViewSize(view.width, view.height);
    };
    new ResizeObserver(apply).observe(this.elCanvasArea);
    apply();
  }

  // --- The page's frame loop ---

  // Called once the page's battlefield is set up (main.ts): its frames run while it is in view
  pageReady(): void {
    this.setMainDrawing(!this.front.isOpen());
  }

  // The page's own view is neither stepped nor drawn while the front end covers it. stop() before
  // every start(), so there is never a second loop.
  private setMainDrawing(on: boolean): void {
    this.engine.stop();
    if (on) this.engine.start();
  }

  // --- Start, the pause menu, the Controls screen ---

  // Start in Match setup or the Sandbox (or Play): set up the run, keep it paused behind the
  // loading screen, then start it. The front end (and its attract battle) is gone first.
  private async start(): Promise<void> {
    if (this.loading.isActive()) return;
    const choice = this.menu.readStart();
    if (!choice) return;
    this.lastMode = this.menu.mode;
    this.front.close();
    this.pause.close();
    this.inMenu = false;
    document.body.dataset.screen = 'run';
    this.replays.exit(false); // the new run replaces the one behind the replay
    this.resetView();

    if (choice.kind === 'stress') {
      // Restart (R) repeats the stress test; no AI layers in classic modes
      this.lastConfig = DEFAULT_CONFIG;
      this.engine.restartStressTest();
      this.startControllers();
    } else {
      this.lastConfig = choice.cfg;
      this.mapChoice = choice.mapChoice;
      this.engine.applyConfig(choice.cfg);
      this.engine.restart();
      // AI controllers tick inside the engine update, so they stay idle while paused
      this.startControllers();
    }
    this.runStarted = true;
    this.hud.reset();
    this.updateSpeedDisplay();

    // restart() unpauses; pause before the first frame so no sim time passes
    this.engine.pause();
    await this.loading.run(
      this.engine.isStressMode() ? 'stress' : this.engine.isBattleMode() ? 'battle' : 'classic',
      this.lastConfig
    );
    this.engine.resume();
    this.sound.play('start');
  }

  // What waits behind the menus: a replay being watched, a run, or nothing
  private runBehind(): 'battle' | 'replay' | null {
    return this.replays.player ? 'replay' : this.runStarted ? 'battle' : null;
  }

  // The run (or replay) waits paused behind the pause menu or the front end; how it was before
  // is kept for Continue
  private enterMenu(): void {
    if (this.inMenu) return;
    this.inMenu = true;
    this.pausedBeforeMenu = this.engine.isPaused();
    this.engine.pause();
    const player = this.replays.player;
    this.replayPlayingBeforeMenu = !!player && player.isPlaying();
    player?.pause();
  }

  // Esc, Menu and a result card's Menu: the pause menu over the run or replay (with nothing
  // behind, the title screen)
  private openPause(): void {
    if (this.pause.isOpen()) return;
    const what = this.runBehind();
    if (!what) {
      this.front.open('title', 'title');
      return;
    }
    this.enterMenu();
    this.pause.open(what);
  }

  // Back to the run or replay; each resumes only if it was running when the menu opened
  private continueRun(): void {
    this.front.close();
    this.pause.close();
    document.body.dataset.screen = 'run';
    if (!this.inMenu) return;
    this.inMenu = false;
    const player = this.replays.player;
    if (player) {
      if (this.replayPlayingBeforeMenu && !player.isPlaying()) player.togglePlay();
      return;
    }
    if (this.runStarted && !this.pausedBeforeMenu && !this.engine.getResult()) {
      this.engine.resume();
    }
  }

  private wireMenuButtons(): void {
    document.getElementById('btn-close-instructions')!.addEventListener('click', () => {
      this.closeControls();
    });
    // The hints start over (now, in a battle the user commands or watches)
    document.getElementById('btn-hints-again')!.addEventListener('click', () => {
      this.hints.showAgain();
      this.closeControls();
    });
  }

  private openControls(): void {
    this.elInstructions.style.display = 'flex';
    document.getElementById('btn-close-instructions')!.focus();
  }

  // The Controls screen closes; the focus goes back to the button that opened it
  private closeControls(): void {
    this.elInstructions.style.display = 'none';
    if (this.pause.isOpen()) this.pause.focusControls();
    else if (this.front.isOpen()) document.getElementById('menu-instructions')!.focus();
  }

  private isMenuOpen(): boolean {
    return this.front.isOpen() || this.pause.isOpen();
  }

  private isHelpOpen(): boolean {
    return this.elInstructions.style.display === 'flex';
  }

  // What the in-context hints are about: a battle the user commands, a battle watched (a replay,
  // or AI commanders on both sides), or nothing to hint at
  private hintMode(): HintMode {
    if (this.isMenuOpen() || this.isHelpOpen() || this.loading.isActive()) return null;
    if (this.replays.player) return 'watch';
    if (!this.runStarted || !this.engine.isBattleMode()) return null;
    if (this.engine.getResult() || this.engine.getError()) return null;
    return (this.lastConfig.friendlyAI ?? 'none') === 'none' ? 'play' : 'watch';
  }

  // --- Button events ---

  private wireButtonEvents(): void {
    this.elBtnPause.addEventListener('click', () => this.togglePause());

    document.getElementById('btn-faster')!.addEventListener('click', () => this.changeSpeed(1));
    document.getElementById('btn-slower')!.addEventListener('click', () => this.changeSpeed(-1));
    document.getElementById('btn-restart')!.addEventListener('click', () => this.doRestart());
    document
      .getElementById('btn-save-map')!
      .addEventListener('click', () =>
        this.menu.saveCurrentMap(this.stateManager.getBattlefield().grid)
      );
    document.getElementById('btn-menu')!.addEventListener('click', () => this.openPause());
    document.getElementById('btn-help')!.addEventListener('click', () => this.openControls());
    document.getElementById('btn-log')!.addEventListener('click', () => this.downloadLog());
    this.toggles.wire();
  }

  // Pause, speed and restart act on the replay while one is watched
  private togglePause(): void {
    const player = this.replays.player;
    if (player) {
      player.togglePlay();
      return;
    }
    // A finished match stays stopped; restart or the menu starts a new one
    if (this.engine.getResult()) return;
    this.engine.togglePause();
    this.updatePauseButton();
  }

  private changeSpeed(step: 1 | -1): void {
    const player = this.replays.player;
    if (player) {
      player.changeSpeed(step);
      this.updateSpeedDisplay();
      return;
    }
    if (step > 0) this.engine.increaseSpeed();
    else this.engine.decreaseSpeed();
    this.updateSpeedDisplay();
    this.toggles.save();
  }

  // --- Input events ---

  private wireInputEvents(): void {
    this.inputHandler.onKeyDown((key: string) => {
      // Shortcuts would unpause or restart the run behind the loading screen
      if (this.loading.isActive()) return;
      // A dialog (the AI bridge's instructions, About) has the keyboard; Esc closes it itself
      if (dialogOpen()) return;
      if (key === 'Escape') {
        if (this.isHelpOpen()) this.closeControls();
        else if (this.front.isOpen()) this.front.back();
        else if (this.pause.isOpen()) this.continueRun();
        else this.openPause();
        return;
      }
      // Game shortcuts only act on the battlefield, not behind the menus or the help screen
      if (this.isMenuOpen() || this.isHelpOpen()) return;
      switch (key) {
        case ' ':
          this.togglePause();
          break;
        case '+':
        case '=':
          this.changeSpeed(1);
          break;
        case '-':
          this.changeSpeed(-1);
          break;
        case 'r':
        case 'R':
          this.doRestart();
          break;
      }
    });

    // Mouse on the battlefield and the minimap
    this.canvas.wire();

    // The hints go on when the user does what they say
    this.inputHandler.onKeyDown((key) => this.hints.keyPressed(key));
    this.canvas.onUserAction((action, unit) => {
      if (action === 'select') this.hints.userSelected(unit);
      else this.hints.userOrdered();
    });
  }

  // --- Match end ---

  // Battle mode: shown when the match is decided.
  private showMatchResult(r: MatchResult): void {
    // The player hears a win or a loss for their own side; a spectator hears the end of a
    // decided match, and a draw sounds like a loss
    const playerSide = (this.lastConfig.friendlyAI ?? 'none') === 'none' ? Faction.FRIENDLY : null;
    const won = r.winner !== null && (playerSide === null || r.winner === playerSide);
    this.sound.play(won ? 'victory' : 'defeat');
    const replay = this.replays.finish(r);
    this.hud.showResult(r, this.lastConfig, {
      restart: () => this.doRestart(),
      menu: () => this.openPause(),
      log: () => this.downloadLog(),
      watch: replay?.watch ?? null,
      saveReplay: replay?.save ?? null,
    });
    this.updatePauseButton();
  }

  // A simulation error stopped the run: say so instead of leaving a frozen battlefield.
  private showError(message: string): void {
    this.hud.showError(message, this.stateManager.getBattlefield().elapsedTime, {
      restart: () => this.doRestart(),
      menu: () => this.openPause(),
      log: this.matchLog ? () => this.downloadLog() : null,
    });
    this.updatePauseButton();
  }

  private downloadLog(): void {
    this.matchLog?.download(this.stateManager, this.engine.getResult(), this.engine.getError());
  }

  // Attaches the AI layers chosen for each side of this match and starts its match log.
  // Restart clears them, so this runs after every engine.restart(). Running controllers are
  // exposed as window.ai.west / window.ai.east ({ jev, llm }) for inspection in the console.
  private startControllers(): void {
    this.hud.hideResult();
    this.aiSides = { west: {}, east: {} };
    const debug = window as unknown as { ai?: AiSides };
    debug.ai = this.aiSides;
    const battle = this.lastConfig.mode === 'battle' && !this.engine.isStressMode();
    this.matchLog = battle ? new MatchLog(this.lastConfig, this.mapChoice, this.aiSides) : null;
    document.getElementById('btn-log')!.hidden = !battle;
    this.replays.record(
      battle,
      this.lastConfig,
      this.mapChoice,
      this.stateManager.getBattlefield()
    );
    if (!battle) return;

    const controllers: AIController[] = [];
    const sides: Array<[Faction, SideAI, 'west' | 'east', LlmModel, TacticalModel]> = [
      [
        Faction.FRIENDLY,
        this.lastConfig.friendlyAI ?? 'none',
        'west',
        this.lastConfig.friendlyModel ?? 'sonnet',
        this.lastConfig.friendlyTactical ?? 'jev',
      ],
      [
        Faction.ENEMY,
        this.lastConfig.enemyAI ?? 'none',
        'east',
        this.lastConfig.enemyModel ?? 'sonnet',
        this.lastConfig.enemyTactical ?? 'jev',
      ],
    ];
    for (const [faction, ai, name, model, tactical] of sides) {
      if (ai === 'none') continue;
      // The LLM commands the side; with Jev it is the LLM's tactical layer (Jev alone was
      // dropped: it sees only each hero's surroundings)
      const both = ai === 'jev+llm';
      const side = this.aiSides[name];
      if (both) {
        side.jev = new JevController(this.engine, this.stateManager, faction, {
          fallbackToRules: false,
          withCommander: true,
          model: tactical,
        });
        controllers.push(side.jev);
      }
      side.llm = new LlmController(this.engine, this.stateManager, faction, {
        model,
        fallbackToRules: !both,
        jevAssessment: side.jev ? (heroIndex) => side.jev!.assessmentFor(heroIndex) : null,
        tacticalName: TACTICAL_NAME[tactical],
      });
      controllers.push(side.llm);
    }
    this.engine.setControllers(controllers);
  }

  // --- Restart ---

  // Clears the selection and the terrain drawn for the old map, before a new run.
  private resetView(): void {
    this.canvas.clearSelection();
    this.renderer.clearTerrainCache();
    this.minimapRenderer.clearTerrainCache();
  }

  private doRestart(): void {
    if (this.loading.isActive()) return;
    // In a replay: back to its start
    const player = this.replays.player;
    if (player) {
      player.seek(0);
      return;
    }
    this.resetView();
    // Restarting a stress test runs the stress test again (it used to restart as Default)
    if (this.engine.isStressMode()) this.engine.restartStressTest();
    else {
      this.engine.applyConfig(this.lastConfig);
      this.engine.restart();
    }
    this.startControllers();
    this.hud.reset();
    this.updatePauseButton();
    this.updateSpeedDisplay();
  }

  private updateSpeedDisplay(): void {
    const player = this.replays.player;
    this.elSpeedDisplay.textContent = `${player ? player.getSpeed() : this.engine.getSpeed()}x`;
  }

  private startUIRefresh(): void {
    setInterval(() => {
      const player = this.replays.player;
      if (player) {
        // A replay puts back the panels it recorded; the live run waits behind it
        player.applyPanels();
        this.updatePauseButton();
        this.canvas.refreshSelection();
        this.hints.update();
        return;
      }
      this.hud.update(this.lastConfig);
      this.matchLog?.sample(this.stateManager);
      this.aiPanel.update(
        this.aiSides,
        this.lastConfig,
        this.stateManager.getBattlefield().elapsedTime,
        this.stateManager.getHeroes(),
        this.stateManager
      );
      this.replays.samplePanels();
      this.updatePauseButton();
      this.canvas.refreshSelection();
      this.hints.update();
    }, 100);
  }
}
