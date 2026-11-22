import type { TerrainType } from '../types/types';
import { decodeGrid, listSavedMaps, loadSavedMap } from '../state/MapStore';
import { FIXED_MAP } from '../maps/fixedMap';
import { segValue, setSeg, wireSeg } from './seg';

// A map choice (D5): Random / Fixed / Saved, and the saved map's list, shown only for Saved. Match
// setup and the Sandbox each have one.
export class MapChoice {
  private select: HTMLSelectElement;
  // Called after the choice, the saved map chosen or the saved maps change (Match setup's preview)
  onChange: () => void = () => {};

  constructor(
    private groupId: string,
    selectId: string
  ) {
    this.select = document.getElementById(selectId) as HTMLSelectElement;
    wireSeg(groupId, () => {
      this.showList();
      this.onChange();
    });
    this.select.addEventListener('change', () => this.onChange());
    this.refresh();
  }

  get choice(): string {
    return segValue(this.groupId);
  }

  set choice(value: string) {
    setSeg(this.groupId, value);
    this.showList();
    this.onChange();
  }

  // The saved maps of this browser, the chosen one kept when it is still there
  refresh(): void {
    const kept = this.select.value;
    const names = listSavedMaps();
    this.select.innerHTML = '';
    for (const name of names) this.select.add(new Option(name, name));
    if (names.length === 0) this.select.add(new Option('(no saved maps)', ''));
    if (names.includes(kept)) this.select.value = kept;
    this.onChange();
  }

  showList(): void {
    this.select.hidden = this.choice !== 'saved';
  }

  // Why Start cannot use this map, or null. A saved map that cannot be read must not silently
  // become a random one: paired experiments rely on the map.
  problem(): string | null {
    if (this.choice !== 'saved') return null;
    if (!this.select.value)
      return 'There is no saved map yet: save one with the "Save this map" button in the top bar first.';
    if (!loadSavedMap(this.select.value))
      return `The saved map "${this.select.value}" could not be read. Choose another map.`;
    return null;
  }

  // The terrain for the run; undefined means a random map (a new one, or Match setup's preview's)
  grid(): TerrainType[][] | undefined {
    if (this.choice === 'fixed') return decodeGrid(FIXED_MAP) ?? undefined;
    if (this.choice === 'saved' && this.select.value)
      return loadSavedMap(this.select.value) ?? undefined;
    return undefined;
  }

  // The map for the match log: random, fixed or "saved: <name>"
  label(): string {
    return this.choice === 'saved' ? `saved: ${this.select.value}` : this.choice;
  }

  // The saved map chosen (its name)
  savedName(): string {
    return this.select.value;
  }

  focus(): void {
    (this.choice === 'saved' ? this.select : this.activeButton())?.focus();
  }

  private activeButton(): HTMLElement | null {
    return document.querySelector(`#${this.groupId} button.active`);
  }
}
