import { escapeHtml } from './format';

// A drop-down list in the menu's own pixel style (the browser's <select> cannot be styled to
// match it): a button with the chosen item, and a list of items grouped under headings. Works
// with the mouse and the keyboard (arrows, Home/End, Enter or Space, Esc) and closes when the
// focus or a click leaves it. Used for the OpenRouter model list (D52).

export interface DropdownItem {
  value: string;
  label: string;
  group?: string;
}

let nextId = 1;

export class Dropdown {
  private button: HTMLButtonElement;
  private list: HTMLElement;
  private items: DropdownItem[];
  private current: string;
  private active = 0; // item highlighted while the list is open
  private onChange: (value: string) => void = () => {};

  constructor(root: HTMLElement, items: DropdownItem[], value: string) {
    this.items = items;
    this.current = items.some((i) => i.value === value) ? value : (items[0]?.value ?? '');
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
      const item = (e.target as HTMLElement).closest<HTMLElement>('.dd-item');
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
    if (!this.items.some((i) => i.value === value)) return;
    this.current = value;
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
      html +=
        `<div class="dd-item${selected ? ' selected' : ''}" role="option" id="${this.list.id}-${index}" ` +
        `data-index="${index}" aria-selected="${selected}">${escapeHtml(item.label)}</div>`;
    });
    this.list.innerHTML = html;
  }

  private open(): void {
    this.list.hidden = false;
    // Opens upward when there is not enough room below (the menu ends near the screen's edge)
    this.list.classList.remove('up');
    const box = this.button.getBoundingClientRect();
    const height = this.list.getBoundingClientRect().height;
    const below = window.innerHeight - box.bottom;
    if (below < height + 8 && box.top > below) this.list.classList.add('up');
    this.button.setAttribute('aria-expanded', 'true');
    this.highlight(
      Math.max(
        0,
        this.items.findIndex((i) => i.value === this.current)
      )
    );
    this.list.focus();
  }

  private close(focusButton = true): void {
    this.list.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (focusButton) this.button.focus();
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
    if (!item) return;
    const changed = item.value !== this.current;
    this.current = item.value;
    this.render();
    this.close();
    if (changed) this.onChange(item.value);
  }

  private onKey(e: KeyboardEvent): void {
    const moves: Record<string, number> = {
      ArrowDown: this.active + 1,
      ArrowUp: this.active - 1,
      Home: 0,
      End: this.items.length - 1,
    };
    if (e.key in moves) this.highlight(moves[e.key]);
    else if (e.key === 'Enter' || e.key === ' ') this.choose(this.active);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.stopPropagation(); // Esc must close the list, not the menu
      this.close(e.key === 'Escape');
      if (e.key === 'Tab') return;
    } else return;
    e.preventDefault();
  }
}
