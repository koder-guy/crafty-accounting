/**
 * Called from a capturing pointerdown outside an open menu: closes the menu
 * and swallows the rest of that press, so dismissing the menu doesn't also
 * press whatever was underneath (a table row, a link, another button).
 */
export function dismissWithoutClicking(e: PointerEvent, close: () => void): void {
  // Stops focus moving and text being selected under the pointer.
  e.preventDefault();
  close();
  const swallow = (click: Event) => {
    click.preventDefault();
    click.stopPropagation();
    done();
  };
  const done = () => {
    window.removeEventListener('click', swallow, true);
    clearTimeout(timer);
  };
  window.addEventListener('click', swallow, true);
  // If the press never becomes a click (e.g. it turns into a drag), stop waiting for one.
  const timer = window.setTimeout(done, 1000);
}
