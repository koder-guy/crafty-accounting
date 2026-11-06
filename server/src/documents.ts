// Attached documents live in DATA_DIR/uploads under their original filename,
// or the name given when renamed. Names are validated (and checked for clashes)
// before anything is written to disk or the database.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { diskSize, MAX_DOCUMENTS, minimumFreeForUploads } from '@crafty/shared';
import { listAutoBackups } from './autoBackup';
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

/** Free space on the disk holding the documents, and how much must stay free; null if it can't be read. */
export function uploadSpace(ctx: AppContext): { freeBytes: number; minimumFreeBytes: number } | null {
  const space = ctx.diskSpace(ctx.paths.uploadsDir);
  if (!space) return null;
  const newestBackup = listAutoBackups(ctx.paths.backupDir)[0]?.sizeBytes ?? 0;
  return { freeBytes: space.freeBytes, minimumFreeBytes: minimumFreeForUploads(newestBackup) };
}

/**
 * Refuses (507) to store `bytes` more when that would leave the disk below the minimum, so a pile
 * of documents can't fill it and leave no room for the books or the next backup. Free space can't
 * be reserved, so this is a first check; writes still clean up if the disk fills anyway.
 */
export function ensureSpaceFor(ctx: AppContext, bytes: number): void {
  const space = uploadSpace(ctx);
  if (!space || space.freeBytes - bytes >= space.minimumFreeBytes) return;
  throw new HttpError(
    507,
    `The server's disk is nearly full (${diskSize(space.freeBytes)} free), so no more documents can be stored. Free up some space, or keep fewer automatic backups, then try again.`,
  );
}

export function createUploader(ctx: AppContext) {
  return multer({
    dest: ctx.paths.tmpDir,
    limits: { fileSize: ctx.config.maxUploadMb * 1024 * 1024, files: MAX_DOCUMENTS },
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

/** Files uploaded with a transaction (multer puts them on req.files). */
export const uploadedFiles = (files: unknown): Express.Multer.File[] => (Array.isArray(files) ? files : []);

/** Gives a stored file a second name, refusing one already taken; the old name is removed once the change is saved. */
function linkDocument(ctx: AppContext, from: string, to: string): void {
  const clash = () => new HttpError(409, `A document called "${to}" is already stored. Choose another name.`);
  try {
    fs.linkSync(documentPath(ctx, from), documentPath(ctx, to));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw clash();
    if (code === 'ENOENT') throw new HttpError(422, `The file for "${from}" is missing from storage, so it can't be renamed`);
    // Storage without hard links: copy instead.
    try {
      fs.copyFileSync(documentPath(ctx, from), documentPath(ctx, to), fs.constants.COPYFILE_EXCL);
    } catch (copyErr) {
      if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') throw clash();
      throw copyErr;
    }
  }
}

/** A file's SHA-256, to notice the same file scanned again. */
export function fileFingerprint(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export interface DocumentRename {
  from: string;
  to: string;
}

/**
 * Places uploaded documents under their original names and renamed ones under
 * their new names, runs the database write with the uploaded names, then tidies
 * up: the new files are removed if the write fails, and the `removing` files
 * (documents dropped by the write) and renamed files' old names are deleted if
 * it succeeds. Every name is checked before anything is written.
 */
export function saveWithDocuments<T>(
  ctx: AppContext,
  change: { files: Express.Multer.File[]; removing: string[]; renaming?: DocumentRename[] },
  write: (filenames: string[]) => T,
): T {
  const placed: string[] = [];
  const renaming = change.renaming ?? [];
  try {
    if (change.files.length) ensureSpaceFor(ctx, change.files.reduce((sum, f) => sum + f.size, 0));
    const names = change.files.map((f) => decodeUploadName(f.originalname));
    const newNames = [...names, ...renaming.map((r) => r.to)];
    for (const [i, name] of newNames.entries()) {
      const problem = documentNameProblem(name);
      if (problem) throw new HttpError(400, `${name}: ${problem}`);
      const clash = newNames.indexOf(name) !== i || isDocumentNameInUse(ctx.db, name) || fs.existsSync(documentPath(ctx, name));
      if (clash) {
        throw new HttpError(409, `A document called "${name}" is already stored. ${i < names.length ? 'Rename the file and try again.' : 'Choose another name.'}`);
      }
    }
    for (const [i, file] of change.files.entries()) {
      try {
        fs.copyFileSync(file.path, documentPath(ctx, names[i]), fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new HttpError(409, `A document called "${names[i]}" is already stored. Rename the file and try again.`);
        }
        throw err;
      }
      placed.push(names[i]);
    }
    for (const { from, to } of renaming) {
      linkDocument(ctx, from, to);
      placed.push(to);
    }

    const result = write(names);
    // Fingerprinted, so scanning the same file again is noticed.
    const fingerprint = ctx.db.prepare('UPDATE documents SET sha256 = ? WHERE filename = ? AND sha256 IS NULL');
    for (const name of names) fingerprint.run(fileFingerprint(documentPath(ctx, name)), name);
    for (const name of change.removing) removeDocumentFile(ctx, name);
    for (const { from } of renaming) removeDocumentFile(ctx, from);
    placed.length = 0;
    return result;
  } finally {
    // Only still set if something failed after the files were placed.
    for (const name of placed) removeDocumentFile(ctx, name);
    for (const file of change.files) fs.rmSync(file.path, { force: true });
  }
}
