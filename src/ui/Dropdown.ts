import { escapeHtml } from './format';

// A drop-down list in the menu's own pixel style (the browser's <select> cannot be styled to
// match it): a button with the chosen item, and a list of items grouped under headings. Works
// with the mouse and the keyboard (arrows, Home/End, Enter or Space, Esc) and closes when the
// focus or a click leaves it. Used for Match setup's model lists (D52, the AI server's and the AI
// bridge's models). Labels and notes are escaped (escapeHtml): a model name from the bridge is
// shown as text. A disabled item is shown with its note (why it cannot be chosen) and is never
// chosen: not by the mouse, the keys, `value` or `setItems`.

export interface DropdownItem {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
  note?: string; // shown under the label (a disabled item: why)
}

// The value to show: `value` when it is an item that can be chosen, else the first such item
function choosable(items: DropdownItem[], value: string): string {
  const can = items.filter((i) => !i.disabled);
  return can.some((i) => i.value === value) ? value : (can[0]?.value ?? '');
}

let nextId = 1;

// The part of the window a list inside `el` can be seen in: the window, cut by every box around
// it that clips what overflows (a scrolling settings body)
function clipBox(el: HTMLElement | null): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  if (typeof getComputedStyle !== 'function') return { top, bottom };
  for (let e = el; e; e = e.parentElement) {
    if (getComputedStyle(e).overflowY === 'visible') continue;
    const r = e.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}

export class Dropdown {
  private button: HTMLButtonElement;
  private list: HTMLElement;
  private items: DropdownItem[];
  private current: string;
  private active = 0; // item highlighted while the list is open
  private onChange: (value: string) => void = () => {};

  constructor(root: HTMLElement, items: DropdownItem[], value: string) {
    this.items = items;
    this.current = choosable(items, value);
    const id = `dd-${nextId++}`;
    root.classList.add('dropdown');
    root.innerHTML =
      `<button type="button" class="dd-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}">` +
      `<span class="dd-label"></span><span class="dd-caret" aria-hidden="true"></span></button>` +
      `<div class="dd-list" id="${id}" role="listbox" tabindex="-1" hidden></div>`;
    this.button = root.querySelector('.dd-button')!;
    this.list = root.querySelector('.dd-list')!;
    this.render();

    this.button.addEventListener('click', () => (this.isOpen() ? this.close() : this.open()));
    this.button.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        this.open();
      }
    });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.list.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.dd-item');
      if (item) this.choose(Number(item.dataset.index));
    });
    this.list.addEventListener('mousemove', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.dd-item:not(.disabled)');
      if (item) this.highlight(Number(item.dataset.index), false);
    });
    // Closes when a click or the focus goes elsewhere
    document.addEventListener('mousedown', (e) => {
      if (this.isOpen() && !root.contains(e.target as Node)) this.close(false);
    });
    root.addEventListener('focusout', (e) => {
      if (this.isOpen() && !root.contains(e.relatedTarget as Node | null)) this.close(false);
    });
  }

  get value(): string {
    return this.current;
  }

  set value(value: string) {
    if (!this.items.some((i) => i.value === value && !i.disabled)) return;
    this.current = value;
    this.render();
  }

  // New items (a way's model list); `value` is chosen when it is one of them that can be chosen,
  // else the first that can ('' when none can)
  setItems(items: DropdownItem[], value: string): void {
    if (this.isOpen()) this.close(false);
    this.items = items;
    this.current = choosable(items, value);
    this.render();
  }

  // Called when the user picks an item (not when the value is set in code)
  onChoose(cb: (value: string) => void): void {
    this.onChange = cb;
  }

  private isOpen(): boolean {
    return !this.list.hidden;
  }

  private render(): void {
    const chosen = this.items.find((i) => i.value === this.current);
    this.button.querySelector('.dd-label')!.textContent = chosen?.label ?? '';
    let html = '';
    let group: string | undefined;
    this.items.forEach((item, index) => {
      if (item.group !== group) {
        group = item.group;
        if (group) html += `<div class="dd-group" role="presentation">${escapeHtml(group)}</div>`;
      }
      const selected = item.value === this.current;
      const note = item.note ? `<span class="dd-note">${escapeHtml(item.note)}</span>` : '';
      html +=
        `<div class="dd-item${selected ? ' selected' : ''}${item.disabled ? ' disabled' : ''}" role="option" id="${this.list.id}-${index}" ` +
        `data-index="${index}" aria-selected="${selected}"${item.disabled ? ' aria-disabled="true"' : ''}>` +
        `<span class="dd-text">${escapeHtml(item.label)}</span>${note}</div>`;
    });
    this.list.innerHTML = html;
  }

  private open(): void {
    this.list.hidden = false;
    // Opens upward when there is not enough room below (the menu ends near the screen's edge),
    // within what clips it: the window, or the settings' body when it scrolls (small windows);
    // a list taller than the room it gets scrolls in it
    this.list.classList.remove('up');
    this.list.style.maxHeight = '';
    const box = this.button.getBoundingClientRect();
    const height = this.list.getBoundingClientRect().height;
    const clip = clipBox(this.list.parentElement);
    const below = clip.bottom - box.bottom;
    const above = box.top - clip.top;
    const up = below < height + 8 && above > below;
    if (up) this.list.classList.add('up');
    const room = Math.floor((up ? above : below) - 8);
    if (height > room) this.list.style.maxHeight = `${Math.max(80, room)}px`;
    this.button.setAttribute('aria-expanded', 'true');
    const at = this.items.findIndex((i) => i.value === this.current && !i.disabled);
    this.highlight(at >= 0 ? at : this.step(-1, 1));
    this.list.focus();
  }

  private close(focusButton = true): void {
    this.list.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (focusButton) this.button.focus();
  }

  // The next item that can be chosen from `from` in direction `dir` (1 or -1), or `from` itself when
  // there is none that way (-1 when no item can be chosen)
  private step(from: number, dir: 1 | -1): number {
    for (let i = from + dir; i >= 0 && i < this.items.length; i += dir)
      if (!this.items[i].disabled) return i;
    return from >= 0 && from < this.items.length && !this.items[from].disabled ? from : -1;
  }

  private highlight(index: number, scroll = true): void {
    this.active = Math.max(0, Math.min(this.items.length - 1, index));
    this.list
      .querySelectorAll('.dd-item')
      .forEach((el, i) => el.classList.toggle('active', i === this.active));
    this.list.setAttribute('aria-activedescendant', `${this.list.id}-${this.active}`);
    if (scroll)
      this.list
        .querySelector<HTMLElement>(`[data-index="${this.active}"]`)
        ?.scrollIntoView({ block: 'nearest' });
  }

  private choose(index: number): void {
    const item = this.items[index];
    if (!item || item.disabled) return;
    const changed = item.value !== this.current;
    this.current = item.value;
    this.render();
    this.close();
    if (changed) this.onChange(item.value);
  }

  private onKey(e: KeyboardEvent): void {
    // Disabled items are passed over
    const moves: Record<string, number> = {
      ArrowDown: this.step(this.active, 1),
      ArrowUp: this.step(this.active, -1),
      Home: this.step(-1, 1),
      End: this.step(this.items.length, -1),
    };
    if (e.key in moves) {
      if (moves[e.key] >= 0) this.highlight(moves[e.key]);
    } else if (e.key === 'Enter' || e.key === ' ') this.choose(this.active);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.stopPropagation(); // Esc must close the list, not the menu
      this.close(e.key === 'Escape');
      if (e.key === 'Tab') return;
    } else return;
    e.preventDefault();
  }
}
