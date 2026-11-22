import { SimConfig, DEFAULT_CONFIG, TerrainDensity } from '../types/types';
import { MapChoice } from './MapChoice';
import { segValue, setSeg, wireSeg } from './seg';

// The Sandbox: Phase 1's classic mode (D19, its numbers fixed: DEFAULT_CONFIG), the classic mode
// with your own army size, wave strength and terrain (Custom), and the stress test. Classic and
// Custom take a map choice; the stress test has its own.

export type SandboxTab = 'tab-default' | 'tab-custom' | 'tab-stress';
export const SANDBOX_TABS: SandboxTab[] = ['tab-default', 'tab-custom', 'tab-stress'];

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class Sandbox {
  readonly map = new MapChoice('sb-map', 'sb-map-saved');
  private tab: SandboxTab = 'tab-default';
  private warriors = $('sb-warriors') as HTMLInputElement;
  private warriorsNum = $('sb-warriors-num') as HTMLInputElement;
  private waves = $('cfg-wave-slider') as HTMLInputElement;
  // Called after any change of the controls (the plain-language line follows the tab)
  onChange: () => void = () => {};

  constructor() {
    const { warriors, warriorsNum, waves } = this;
    for (const id of SANDBOX_TABS) $(id).addEventListener('click', () => this.setTab(id));
    warriors.addEventListener('input', () => (warriorsNum.value = warriors.value));
    warriorsNum.addEventListener('input', () => {
      const v = Math.min(2000, Math.max(0, parseInt(warriorsNum.value) || 0));
      warriors.value = v.toString();
    });
    // The clamped value once editing is done (clamping while typing would fight the user)
    warriorsNum.addEventListener('change', () => (warriorsNum.value = warriors.value));
    waves.addEventListener('input', () => this.showWaves());
    wireSeg('sb-terrain', () => this.onChange());
    this.setTab('tab-default');
  }

  get activeTab(): SandboxTab {
    return this.tab;
  }

  // Classic shows its fixed numbers (the controls locked); Custom unlocks them; the stress test
  // has none
  setTab(tab: SandboxTab): void {
    this.tab = tab;
    for (const id of SANDBOX_TABS) {
      $(id).classList.toggle('active', id === tab);
      $(id).setAttribute('aria-pressed', String(id === tab));
    }
    const classic = tab === 'tab-default';
    const stress = tab === 'tab-stress';
    $('sandbox-screen').dataset.tab = classic ? 'classic' : stress ? 'stress' : 'custom';
    if (classic) {
      this.warriors.value = this.warriorsNum.value = String(DEFAULT_CONFIG.warriorCount);
      this.waves.value = String(DEFAULT_CONFIG.waveMultiplier);
      setSeg('sb-terrain', DEFAULT_CONFIG.terrainDensity);
    }
    this.showWaves();
    $('sb-army').hidden = stress;
    $('sb-map-field').hidden = stress;
    const locked = $('sb-army').querySelectorAll('input, button');
    locked.forEach((el) => ((el as HTMLInputElement).disabled = classic));
    $('sb-army').classList.toggle('locked', classic);
    $('msg-sandbox').hidden = true;
    this.onChange();
  }

  // What Start runs: the stress test, or a classic run from these settings; null with a message
  // when the map cannot be used
  read(): { kind: 'stress' } | { kind: 'run'; cfg: SimConfig; mapChoice: string } | null {
    const msg = $('msg-sandbox');
    msg.hidden = true;
    if (this.tab === 'tab-stress') return { kind: 'stress' };
    const problem = this.map.problem();
    if (problem) {
      msg.textContent = problem;
      msg.hidden = false;
      if (typeof msg.getClientRects === 'function' && msg.getClientRects().length === 0)
        window.alert(problem);
      this.map.focus();
      return null;
    }
    const base: SimConfig =
      this.tab === 'tab-default'
        ? DEFAULT_CONFIG
        : {
            ...DEFAULT_CONFIG,
            warriorCount: parseInt(this.warriors.value),
            waveMultiplier: parseFloat(this.waves.value),
            terrainDensity: segValue('sb-terrain') as TerrainDensity,
          };
    const cfg: SimConfig = {
      ...base,
      presetGrid: this.map.grid(),
      friendlyAI: 'none',
      enemyAI: 'none',
      aiTiming: 'realtime',
      recordReplay: true,
      friendlyModel: 'sonnet',
      enemyModel: 'sonnet',
      friendlyTactical: 'jev',
      enemyTactical: 'jev',
    };
    return { kind: 'run', cfg, mapChoice: this.map.label() };
  }

  // The numbers shown next to the controls follow them (after they were put back)
  showValues(): void {
    this.warriorsNum.value = this.warriors.value;
    this.showWaves();
    this.map.showList();
  }

  private showWaves(): void {
    $('cfg-wave-val').textContent = `${this.waves.value}×`;
  }
}
