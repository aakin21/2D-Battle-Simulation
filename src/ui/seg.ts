// Button groups in the menu's pixel style (`.seg`: one row of options, the active one in orange),
// read and set by their buttons' data-val. A click anywhere in the group is handled by the group,
// so a group's options can change without rewiring.

export function segValue(groupId: string): string {
  const active = document
    .getElementById(groupId)!
    .querySelector('button.active') as HTMLButtonElement | null;
  return active?.dataset.val ?? '';
}

// Makes `val` the active option ('' leaves none active); pressed state for screen readers too
export function setSeg(groupId: string, val: string): void {
  document
    .getElementById(groupId)!
    .querySelectorAll('button')
    .forEach((btn) => {
      const on = (btn as HTMLButtonElement).dataset.val === val;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
}

// Whether the group offers `val` as an option the user can see
export function segOffers(groupId: string, val: unknown): boolean {
  return Array.from(document.getElementById(groupId)!.querySelectorAll('button')).some(
    (b) => (b as HTMLButtonElement).dataset.val === val && !(b as HTMLButtonElement).hidden
  );
}

// A click on one of the group's buttons makes it the active option, then calls `changed`
export function wireSeg(groupId: string, changed: (val: string) => void): void {
  const group = document.getElementById(groupId)!;
  setSeg(groupId, segValue(groupId));
  group.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!btn || btn.disabled || btn.dataset.val === undefined) return;
    setSeg(groupId, btn.dataset.val);
    changed(btn.dataset.val);
  });
}
