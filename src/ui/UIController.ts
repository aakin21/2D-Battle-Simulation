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
import { Hud } from './Hud';
import { AiPanel } from './AiPanel';
import { AiSides, MatchLog } from './MatchLog';
import { Sound } from './Sound';
import { MainMenu } from './MainMenu';
import { CanvasInteraction } from './CanvasInteraction';
import {
  savedBars,
  savedDebug,
  savedEffects,
  savedSpeed,
  saveSettings,
  soundMuted,
} from './Settings';
import { icon } from './icons';
import { ReplayRecorder } from '../replay/ReplayRecorder';
import { ReplayPlayer } from '../replay/ReplayPlayer';
import { decodeReplay, Replay } from '../replay/Replay';
import heroWestUrl from '../assets/sprites/hero_knight_gold.png';
import heroEastUrl from '../assets/sprites/hero_shaman_lion.png';
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
  private hud: Hud;
  private aiPanel = new AiPanel();
  private sound: Sound;
  private menu: MainMenu;
  private canvas: CanvasInteraction;
  private aiSides: AiSides = { west: {}, east: {} };
  private matchLog: MatchLog | null = null;
  // Which map the current run uses, for the match log: random, fixed or "saved: <name>"
  private mapChoice: string = 'random';
  private debugMode: boolean = false;
  private lastConfig: SimConfig = DEFAULT_CONFIG;
  // A run started from the menu exists (the menu can go back to it)
  private runStarted: boolean = false;
  private pausedBeforeMenu: boolean = false;
  private shownPaused: boolean | null = null;
  // The replay of the current battle-mode match being recorded, and a replay being watched
  private recorder: ReplayRecorder | null = null;
  private player: ReplayPlayer | null = null;
  private resultShownBeforeReplay = false;

  private elBtnPause: HTMLButtonElement;
  private elBtnDebug: HTMLButtonElement;
  private elBtnEffects: HTMLButtonElement;
  private elSpeedDisplay: HTMLElement;
  private elMainMenu: HTMLElement;
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

    this.elBtnPause = document.getElementById('btn-pause') as HTMLButtonElement;
    this.elBtnDebug = document.getElementById('btn-debug') as HTMLButtonElement;
    this.elBtnEffects = document.getElementById('btn-effects') as HTMLButtonElement;
    this.elSpeedDisplay = document.getElementById('speed-display')!;
    this.elMainMenu = document.getElementById('main-menu')!;
    this.elInstructions = document.getElementById('instructions-overlay')!;
    this.elCanvasArea = document.getElementById('canvas-area')!;

    this.setIcons();
    this.wireSound();
    this.buildHelp();
    this.watchCanvasSize();
    this.loadSettings();
    this.menu = new MainMenu();
    this.wireMenuButtons();
    this.engine.setOnMatchEnd((r) => this.showMatchResult(r));
    this.engine.setOnStep(() => this.recorder?.sample());
    this.wireReplay();
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
    document.getElementById('title-west')!.style.backgroundImage = `url(${heroWestUrl})`;
    document.getElementById('title-east')!.style.backgroundImage = `url(${heroEastUrl})`;
    this.updatePauseButton();
  }

  private updatePauseButton(): void {
    const paused = this.player ? !this.player.isPlaying() : this.engine.isPaused();
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
      if (target.closest('.btn, .seg button, .icon-btn')) this.sound.play('click');
    });
    const btn = document.getElementById('btn-sound')!;
    const show = () => {
      const muted = this.sound.isMuted();
      btn.innerHTML = icon(muted ? 'soundOff' : 'soundOn');
      btn.title = muted ? 'Sound is off (click to turn on)' : 'Sound is on (click to mute)';
    };
    btn.addEventListener('click', () => {
      this.sound.setMuted(!this.sound.isMuted());
      show();
      this.saveSettings();
    });
    show();
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

  // --- Main menu ---

  // Start, Continue and the Controls screen; the menu's settings are MainMenu's.
  private wireMenuButtons(): void {
    // Start: set up the run, keep it paused behind the loading screen, then start it
    document.getElementById('menu-start')!.addEventListener('click', async () => {
      if (this.loading.isActive()) return;
      const choice = this.menu.readStart();
      if (!choice) return;
      if (this.player) this.exitReplay();
      this.resetView();
      this.closeMenu();

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
        this.engine.isStressMode() ? 'stress' : this.engine.isBattleMode() ? 'battle' : 'classic'
      );
      this.engine.resume();
      this.sound.play('start');
    });

    document.getElementById('menu-continue')!.addEventListener('click', () => this.closeMenu());

    document.getElementById('menu-instructions')!.addEventListener('click', () => {
      this.elInstructions.style.display = 'flex';
    });

    document.getElementById('btn-close-instructions')!.addEventListener('click', () => {
      this.elInstructions.style.display = 'none';
    });
  }

  private isMenuOpen(): boolean {
    return this.elMainMenu.style.display !== 'none';
  }

  private isHelpOpen(): boolean {
    return this.elInstructions.style.display === 'flex';
  }

  // Opens the menu over the current run, which waits paused behind it.
  private openMenu(): void {
    if (this.isMenuOpen()) return;
    this.pausedBeforeMenu = this.engine.isPaused();
    this.engine.pause();
    this.player?.pause();
    document.getElementById('menu-continue')!.hidden = !this.runStarted && !this.player;
    this.elMainMenu.style.display = 'flex';
  }

  // Back to the run; it resumes only if it was running when the menu opened.
  private closeMenu(): void {
    this.elMainMenu.style.display = 'none';
    // A replay being watched keeps the live run paused behind it
    if (this.player) return;
    if (this.runStarted && !this.pausedBeforeMenu && !this.engine.getResult()) {
      this.engine.resume();
    }
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
    document.getElementById('btn-menu')!.addEventListener('click', () => this.openMenu());
    document.getElementById('btn-help')!.addEventListener('click', () => {
      this.elInstructions.style.display = 'flex';
    });
    document.getElementById('btn-log')!.addEventListener('click', () => this.downloadLog());

    this.elBtnDebug.addEventListener('click', () => {
      this.debugMode = !this.debugMode;
      this.renderer.setDebugMode(this.debugMode);
      this.elBtnDebug.classList.toggle('on', this.debugMode);
      this.saveSettings();
    });

    this.elBtnEffects.addEventListener('click', () => {
      this.renderer.setEffectsEnabled(!this.renderer.isEffectsEnabled());
      this.updateEffectsButton();
      this.saveSettings();
    });

    document.getElementById('btn-bars')!.addEventListener('click', () => {
      this.renderer.setBarsMode(this.renderer.getBarsMode() === 'smart' ? 'all' : 'smart');
      this.updateBarsButton();
      this.saveSettings();
    });
  }

  private togglePause(): void {
    if (this.player) {
      this.player.togglePlay();
      return;
    }
    // A finished match stays stopped; restart or the menu starts a new one
    if (this.engine.getResult()) return;
    this.engine.togglePause();
    this.updatePauseButton();
  }

  private changeSpeed(step: 1 | -1): void {
    if (this.player) {
      this.player.changeSpeed(step);
      this.updateSpeedDisplay();
      return;
    }
    if (step > 0) this.engine.increaseSpeed();
    else this.engine.decreaseSpeed();
    this.updateSpeedDisplay();
    this.saveSettings();
  }

  private updateBarsButton(): void {
    const all = this.renderer.getBarsMode() === 'all';
    const btn = document.getElementById('btn-bars')!;
    btn.classList.toggle('on', all);
    btn.title = all
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

  // --- Input events ---

  private wireInputEvents(): void {
    this.inputHandler.onKeyDown((key: string) => {
      // Shortcuts would unpause or restart the run behind the loading screen
      if (this.loading.isActive()) return;
      if (key === 'Escape') {
        if (this.isHelpOpen()) this.elInstructions.style.display = 'none';
        else if (this.isMenuOpen()) {
          if (this.runStarted || this.player) this.closeMenu();
        } else this.openMenu();
        return;
      }
      // Game shortcuts only act on the battlefield, not behind the menu or the help screen
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
  }

  // --- LocalStorage ---

  private loadSettings(): void {
    const speed = savedSpeed();
    if (speed !== null) {
      this.engine.setSpeed(speed);
      this.updateSpeedDisplay();
    }

    if (savedDebug()) {
      this.debugMode = true;
      this.renderer.setDebugMode(true);
      this.elBtnDebug.classList.add('on');
    }

    this.renderer.setEffectsEnabled(savedEffects());
    this.updateEffectsButton();
    this.renderer.setBarsMode(savedBars());
    this.updateBarsButton();
  }

  private saveSettings(): void {
    saveSettings({
      speed: this.engine.getSpeed(),
      debug: this.debugMode,
      effects: this.renderer.isEffectsEnabled(),
      bars: this.renderer.getBarsMode(),
      muted: this.sound.isMuted(),
    });
  }

  // Battle mode: shown when the match is decided.
  private showMatchResult(r: MatchResult): void {
    // The player hears a win or a loss for their own side; a spectator hears the end of a
    // decided match, and a draw sounds like a loss
    const playerSide = (this.lastConfig.friendlyAI ?? 'none') === 'none' ? Faction.FRIENDLY : null;
    const won = r.winner !== null && (playerSide === null || r.winner === playerSide);
    this.sound.play(won ? 'victory' : 'defeat');
    this.recorder?.finish(r);
    const recorder = this.recorder;
    this.hud.showResult(r, this.lastConfig, {
      restart: () => this.doRestart(),
      menu: () => this.openMenu(),
      log: () => this.downloadLog(),
      watch: recorder ? () => this.watchReplay(recorder.replay()) : null,
      saveReplay: recorder ? () => void recorder.download() : null,
    });
    this.updatePauseButton();
  }

  // A simulation error stopped the run: say so instead of leaving a frozen battlefield.
  private showError(message: string): void {
    this.hud.showError(message, this.stateManager.getBattlefield().elapsedTime, {
      restart: () => this.doRestart(),
      menu: () => this.openMenu(),
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
    this.recorder =
      battle && this.lastConfig.recordReplay !== false
        ? new ReplayRecorder(this.lastConfig, this.mapChoice, this.stateManager.getBattlefield())
        : null;
    document.getElementById('btn-replay')!.hidden = !this.recorder;
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

  // --- Replays ---

  private wireReplay(): void {
    document.getElementById('btn-replay')!.addEventListener('click', () => {
      void this.recorder?.download();
    });
    const file = document.getElementById('menu-replay-file') as HTMLInputElement;
    document.getElementById('menu-replay')!.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      let replay: Replay;
      try {
        replay = await decodeReplay(chosen);
      } catch (err) {
        window.alert(
          `This replay could not be opened: ${err instanceof Error ? err.message : err}`
        );
        return;
      }
      this.closeMenu();
      this.watchReplay(replay);
    });
    // "more" / "less" in a replayed AI panel
    document.getElementById('side-panel')!.addEventListener('click', (e) => {
      this.player?.toggleText(e.target as HTMLElement);
    });
  }

  // Watch a replay over the live run, which stays paused behind it
  private watchReplay(replay: Replay): void {
    if (this.loading.isActive()) return;
    if (this.player) this.exitReplay();
    else this.resultShownBeforeReplay = !document.getElementById('match-result')!.hidden;
    this.engine.pause();
    this.hud.hideResult();
    this.resetView();
    this.player = new ReplayPlayer(replay, {
      exit: () => this.exitReplay(),
      seekReset: () => this.renderer.resetHistory(),
    });
    const player = this.player;
    this.engine.setViewSource(() => player.battlefield());
    this.canvas.setReplayUnits(() => player.units());
    this.renderer.setBattleMode(true);
    document.body.classList.add('replaying');
    this.updatePauseButton();
    this.updateSpeedDisplay();
  }

  private exitReplay(): void {
    if (!this.player) return;
    this.player.dispose();
    this.player = null;
    this.engine.setViewSource(null);
    this.canvas.setReplayUnits(null);
    document.body.classList.remove('replaying');
    this.resetView();
    this.renderer.setBattleMode(this.engine.isBattleMode());
    this.hud.redraw();
    this.aiPanel.redraw();
    if (this.resultShownBeforeReplay) document.getElementById('match-result')!.hidden = false;
    this.updatePauseButton();
    this.updateSpeedDisplay();
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
    if (this.player) {
      this.player.seek(0);
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
    this.elSpeedDisplay.textContent = `${this.player ? this.player.getSpeed() : this.engine.getSpeed()}x`;
  }

  private startUIRefresh(): void {
    setInterval(() => {
      if (this.player) {
        // A replay puts back the panels it recorded; the live run waits behind it
        this.player.applyPanels();
        this.updatePauseButton();
        this.canvas.refreshSelection();
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
      this.recorder?.samplePanels();
      this.updatePauseButton();
      this.canvas.refreshSelection();
    }, 100);
  }
}
