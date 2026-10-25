// Attached documents live in DATA_DIR/uploads under their original filename.
// Names are never changed, so they are validated (and checked for clashes)
// before anything is written to disk or the database.
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import type { AppContext } from './context';
import { HttpError } from './http';
import { isDocumentNameInUse } from './repo';

export const ALLOWED_EXTENSIONS: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

/** Multer stores multipart filenames as latin1; recover the UTF-8 name. */
export function decodeUploadName(name: string): string {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}

/** Returns a reason the name is unsafe to store unchanged, or null if it's fine. */
export function documentNameProblem(name: string): string | null {
  if (!name || name.length > 200) return 'The filename must be between 1 and 200 characters';
  if (/[\\/]/.test(name) || name.includes('..')) return 'The filename must not contain slashes or ".."';
  if (/[\x00-\x1f\x7f]/.test(name)) return 'The filename contains control characters';
  if (name.startsWith('.')) return 'The filename must not start with a dot';
  if (name !== name.trim()) return 'The filename must not start or end with spaces';
  if (!(path.extname(name).toLowerCase() in ALLOWED_EXTENSIONS)) {
    return 'Only PDF and image files (JPG, PNG, WebP, HEIC) can be attached';
  }
  return null;
}

export function documentPath(ctx: AppContext, name: string): string {
  return path.join(ctx.paths.uploadsDir, name);
}

export function createUploader(ctx: AppContext) {
  return multer({
    dest: ctx.paths.tmpDir,
    limits: { fileSize: ctx.config.maxUploadMb * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(decodeUploadName(file.originalname)).toLowerCase();
      if (ext in ALLOWED_EXTENSIONS) cb(null, true);
      else cb(new HttpError(400, 'Only PDF and image files (JPG, PNG, WebP, HEIC) can be attached'));
    },
  });
}

export function removeDocumentFile(ctx: AppContext, name: string | null | undefined): void {
  if (!name) return;
  try {
    fs.unlinkSync(documentPath(ctx, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Could not delete document ${name}`, err);
  }
}

interface DocumentChange {
  file: Express.Multer.File | undefined;
  current: string | null;
  remove: boolean | undefined;
}

/**
 * Places an uploaded document, runs the database write with the resulting
 * filename, then tidies up: the new file is removed if the write fails, and the
 * replaced file is removed if it succeeds.
 */
export function saveWithDocument<T>(ctx: AppContext, change: DocumentChange, write: (filename: string | null) => T): T {
  const { file, current, remove } = change;
  try {
    let filename = remove ? null : current;
    if (file) {
      const name = decodeUploadName(file.originalname);
      const problem = documentNameProblem(name);
      if (problem) throw new HttpError(400, problem);
      if (isDocumentNameInUse(ctx.db, name) || fs.existsSync(documentPath(ctx, name))) {
        throw new HttpError(409, `A document called "${name}" is already stored. Rename the file and try again.`);
      }
      try {
        fs.copyFileSync(file.path, documentPath(ctx, name), fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new HttpError(409, `A document called "${name}" is already stored. Rename the file and try again.`);
        }
        throw err;
      }
      filename = name;
    }

    let result: T;
    try {
      result = write(filename);
    } catch (err) {
      if (file && filename) removeDocumentFile(ctx, filename);
      throw err;
    }
    if (current && current !== filename) removeDocumentFile(ctx, current);
    return result;
  } finally {
    if (file) fs.rmSync(file.path, { force: true });
  }
}
