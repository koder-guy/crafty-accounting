import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CLIENT_ID } from './api';

// The open stream, so printPage can pause it.
let stream: { pause: () => void; resume: () => void } | null = null;

/**
 * Listens for changes made in other browsers (another person, or another tab)
 * and refetches, so everyone sees the same books without reloading. Forms
 * don't lose what you've typed: they only fill themselves once.
 */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    let source: EventSource | null = null;
    // Set when the connection drops (or is paused), so we catch up on anything missed when it reopens.
    let missed = false;
    const refetch = (area?: string) =>
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' || area === 'users' });

    const connect = () => {
      source = new EventSource(`/api/events?client=${CLIENT_ID}`);
      source.addEventListener('changed', (e) => refetch((JSON.parse((e as MessageEvent).data) as { area: string }).area));
      source.addEventListener('error', () => (missed = true));
      source.addEventListener('open', () => {
        if (missed) refetch();
        missed = false;
      });
    };
    const disconnect = () => {
      source?.close();
      source = null;
    };

    connect();
    stream = {
      pause: () => {
        disconnect();
        missed = true;
      },
      resume: () => {
        if (!source) connect();
      },
    };

    // Cmd/Ctrl+P goes through printPage too, so it isn't held up either.
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        printPage();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      disconnect();
      stream = null;
    };
  }, [qc]);
}

/**
 * Opens the print dialog. Safari counts the open live-update stream as the
 * page still loading and holds the dialog back until it closes, so the stream
 * is paused while printing and reconnects (catching up) afterwards.
 */
export function printPage() {
  stream?.pause();
  window.addEventListener('afterprint', () => stream?.resume(), { once: true });
  // Let the browser finish closing the connection before printing.
  setTimeout(() => window.print(), 0);
}
