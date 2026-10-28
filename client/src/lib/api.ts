import type { ApiErrorBody } from '@crafty/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details: ApiErrorBody['details'] = [],
  ) {
    super(message);
  }
}

/**
 * Identifies this browser tab to the server, which then doesn't send the tab
 * live updates about its own changes (see useLiveUpdates in liveUpdates.ts).
 */
export const CLIENT_ID = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { 'X-Client-Id': CLIENT_ID } };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check that it is running.');
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    const err = data as ApiErrorBody | null;
    throw new ApiError(res.status, err?.error ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
};

/** Builds a query string, leaving out empty values. */
export function toQuery(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Multipart body: the record as JSON in "data", plus the optional document. */
export function transactionForm(data: unknown, document: File | null): FormData {
  const form = new FormData();
  form.append('data', JSON.stringify(data));
  if (document) form.append('document', document, document.name);
  return form;
}

export const documentUrl = (filename: string, download = false) =>
  `/api/documents/${encodeURIComponent(filename)}${download ? '?download=1' : ''}`;
