// Tells every open browser when the books change, so a second person sees
// changes without reloading. Each browser holds a Server-Sent Events stream
// (GET /api/events); after a successful change the server sends a short
// "changed" message to every stream except the one that made the change, and
// the client refetches its data.
import type { Response } from 'express';

export interface ChangeEvent {
  /** First part of the API path, e.g. "incomes", "categories" or "restore". */
  area: string;
  /** Name of the person who made the change. */
  by: string;
}

interface Listener {
  res: Response;
  clientId: string | null;
}

const HEARTBEAT_MS = 25_000;

export class LiveUpdates {
  private listeners = new Set<Listener>();

  /** Starts an event stream on the response; it ends when the browser disconnects. */
  subscribe(res: Response, clientId: string | null): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const listener = { res, clientId };
    this.listeners.add(listener);
    // Comments keep proxies from closing an idle connection.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    res.on('close', () => {
      clearInterval(heartbeat);
      this.listeners.delete(listener);
    });
  }

  publish(event: ChangeEvent, fromClientId: string | null): void {
    const message = `event: changed\ndata: ${JSON.stringify(event)}\n\n`;
    for (const listener of this.listeners) {
      if (fromClientId && listener.clientId === fromClientId) continue;
      listener.res.write(message);
    }
  }

  /** Ends every stream, e.g. when the server shuts down. */
  closeAll(): void {
    for (const listener of this.listeners) listener.res.end();
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}
