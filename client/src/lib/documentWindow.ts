import type { MouseEvent } from 'react';

/**
 * Opens a document in a minimal window of its own, beside the page where the browser allows
 * (phones open a tab). Every document opens in the same window, so opening another replaces the last.
 */
export function openDocumentWindow(url: string) {
  const width = Math.min(900, Math.round(window.screen.availWidth / 2));
  const height = Math.round(window.screen.availHeight * 0.9);
  window.open(url, 'crafty-document', `popup,width=${width},height=${height}`)?.focus();
}

/**
 * `onClick` for a link to a document: a plain click opens it with `openDocumentWindow`, while a
 * click with a modifier or the middle button keeps the browser's own behaviour (a new tab, say).
 */
export function openInDocumentWindow(event: MouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  openDocumentWindow(event.currentTarget.href);
}
