import type { SimulationEngine, MatchResult } from '../engine/SimulationEngine';
import type { Renderer } from '../rendering/Renderer';
import type { IBattlefield, SimConfig } from '../types/types';
import { ReplayRecorder } from '../replay/ReplayRecorder';
import { ReplayPlayer } from '../replay/ReplayPlayer';
import { decodeReplay, Replay } from '../replay/Replay';
import type { CanvasInteraction } from './CanvasInteraction';
import type { Hud } from './Hud';
import type { AiPanel } from './AiPanel';
import type { LoadingScreen } from './LoadingScreen';

// Match replays in the page (src/replay): records the current battle-mode match, the Replay
// button in Armies, Watch a replay in the menu, and watching a replay over the live run, which
// waits paused behind it and goes on after Exit. While a replay is watched, UIController sends
// the top bar's pause, speed and restart to `player`.

// What the replay needs from UIController
export interface ReplayHost {
  resetView(): void; // clears the selection and the terrain drawn for the old map
  closeMenu(): void;
  showRunState(): void; // the top bar's pause button and speed follow the replay or the run
}

export class ReplayController {
  private recorder: ReplayRecorder | null = null;
  private watched: ReplayPlayer | null = null;
  private resultShownBeforeReplay = false;

  constructor(
    private engine: SimulationEngine,
    private renderer: Renderer,
    private canvas: CanvasInteraction,
    private hud: Hud,
    private aiPanel: AiPanel,
    private loading: LoadingScreen,
    private host: ReplayHost
  ) {}

  // The replay being watched, or null
  get player(): ReplayPlayer | null {
    return this.watched;
  }

  wire(): void {
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
      this.host.closeMenu();
      this.watch(replay);
    });
    // "more" / "less" in a replayed AI panel
    document.getElementById('side-panel')!.addEventListener('click', (e) => {
      this.watched?.toggleText(e.target as HTMLElement);
    });
  }

  // A new run: battle-mode matches are recorded unless the menu turned it off
  record(battle: boolean, config: SimConfig, mapChoice: string, bf: IBattlefield): void {
    this.recorder =
      battle && config.recordReplay !== false ? new ReplayRecorder(config, mapChoice, bf) : null;
    document.getElementById('btn-replay')!.hidden = !this.recorder;
  }

  // After every simulation step (engine setOnStep)
  sampleFrame(): void {
    this.recorder?.sample();
  }

  // After the UI's refresh drew the panels
  samplePanels(): void {
    this.recorder?.samplePanels();
  }

  // The match is over: the recording ends, and the result card can watch or save it
  finish(r: MatchResult): { watch: () => void; save: () => void } | null {
    const recorder = this.recorder;
    if (!recorder) return null;
    recorder.finish(r);
    return { watch: () => this.watch(recorder.replay()), save: () => void recorder.download() };
  }

  // Watch a replay over the live run, which stays paused behind it
  watch(replay: Replay): void {
    if (this.loading.isActive()) return;
    if (this.watched) this.exit();
    else this.resultShownBeforeReplay = !document.getElementById('match-result')!.hidden;
    this.engine.pause();
    this.hud.hideResult();
    this.host.resetView();
    const player = new ReplayPlayer(replay, {
      exit: () => this.exit(),
      seekReset: () => this.renderer.resetHistory(),
    });
    this.watched = player;
    this.engine.setViewSource(() => player.battlefield());
    this.canvas.setReplayUnits(() => player.units());
    this.renderer.setBattleMode(true);
    document.body.classList.add('replaying');
    this.host.showRunState();
  }

  exit(): void {
    if (!this.watched) return;
    this.watched.dispose();
    this.watched = null;
    this.engine.setViewSource(null);
    this.canvas.setReplayUnits(null);
    document.body.classList.remove('replaying');
    this.host.resetView();
    this.renderer.setBattleMode(this.engine.isBattleMode());
    this.hud.redraw();
    this.aiPanel.redraw();
    if (this.resultShownBeforeReplay) document.getElementById('match-result')!.hidden = false;
    this.host.showRunState();
  }
}
