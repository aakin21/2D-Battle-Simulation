// Small modal dialogs (<dialog>: the AI bridge's instructions, About, the recorded battles): the
// browser keeps the focus inside, Esc closes one, and the focus goes back where it was. A button
// with data-close closes its dialog, as does a click on the dimmed page around it.

// Where the focus goes back to when a dialog closes
const returnFocus = new WeakMap<HTMLElement, HTMLElement>();

// `returnTo`: the element the focus goes back to (default: the one focused now; a dialog opened
// after a button lost its focus, e.g. while it was disabled, passes that button)
export function openDialog(
  el: HTMLElement,
  focus?: HTMLElement | null,
  returnTo?: HTMLElement | null
): void {
  const dialog = el as HTMLDialogElement;
  if (dialog.open) return;
  const back = returnTo ?? (document.activeElement as HTMLElement | null);
  if (back && back !== document.body) returnFocus.set(el, back);
  else returnFocus.delete(el);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', ''); // a page without <dialog> support (tests' fake DOM)
  (focus ?? el.querySelector<HTMLElement>('[data-close]'))?.focus();
}

export function closeDialog(el: HTMLElement): void {
  const dialog = el as HTMLDialogElement;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

// Whether a dialog is open (it has the keyboard: the page's own Esc does nothing then)
export function dialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

export function wireDialog(el: HTMLElement): void {
  el.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => closeDialog(el))
  );
  el.addEventListener('close', () => {
    const back = returnFocus.get(el);
    if (back && back.isConnected && !(back as HTMLButtonElement).disabled) back.focus();
  });
  // The dialog's own box is the element; a click outside it lands on the dialog (its backdrop)
  el.addEventListener('click', (e) => {
    if (e.target !== el || typeof el.getBoundingClientRect !== 'function') return;
    const r = el.getBoundingClientRect();
    const { clientX: x, clientY: y } = e as MouseEvent;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) closeDialog(el);
  });
}
