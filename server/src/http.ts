import type { ErrorRequestHandler, Request } from 'express';
import multer from 'multer';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export function parseWith<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new HttpError(400, details[0]?.message ?? 'Invalid request', details);
  }
  return result.data;
}

/** Reads a JSON body, or the JSON "data" field of a multipart upload. */
export function readPayload(req: Request): unknown {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.data === 'string') {
    try {
      return JSON.parse(body.data);
    } catch {
      throw new HttpError(400, 'Malformed form data');
    }
  }
  return body ?? {};
}

export function parseId(value: string | string[] | undefined): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  return id;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large' : err.message;
    res.status(status).json({ error: message });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request is too large' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
};
