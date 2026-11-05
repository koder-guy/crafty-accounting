// The saved Claude integration (one row in claude_settings). The key is never sent to a browser.
import { claudeKeyHint, DEFAULT_CLAUDE_MODEL, DEFAULT_FILENAME_PATTERN, filenamePatternProblem, isClaudeModel, type ClaudeModel, type ClaudeStatus } from '@crafty/shared';
import type { Db } from './db';

interface Row {
  api_key: string | null;
  key_added_by: string | null;
  key_added_at: string | null;
  model: string | null;
  filename_pattern: string | null;
}

export interface ClaudeSettings {
  apiKey: string | null;
  model: ClaudeModel;
  keyAddedBy: string | null;
  keyAddedAt: string | null;
  filenamePattern: string;
}

export function getClaudeSettings(db: Db): ClaudeSettings {
  const row = db.prepare('SELECT api_key, key_added_by, key_added_at, model, filename_pattern FROM claude_settings WHERE id = 1').get() as Row | undefined;
  return {
    apiKey: row?.api_key ?? null,
    model: isClaudeModel(row?.model) ? row.model : DEFAULT_CLAUDE_MODEL,
    keyAddedBy: row?.api_key ? row.key_added_by : null,
    keyAddedAt: row?.api_key ? row.key_added_at : null,
    filenamePattern: row?.filename_pattern && !filenamePatternProblem(row.filename_pattern) ? row.filename_pattern : DEFAULT_FILENAME_PATTERN,
  };
}

export function claudeStatus(db: Db): ClaudeStatus {
  const s = getClaudeSettings(db);
  return { configured: s.apiKey !== null, keyHint: s.apiKey ? claudeKeyHint(s.apiKey) : null, keyAddedBy: s.keyAddedBy, keyAddedAt: s.keyAddedAt, model: s.model, filenamePattern: s.filenamePattern };
}

const ensureRow = (db: Db) => db.prepare('INSERT OR IGNORE INTO claude_settings (id) VALUES (1)').run();

export function saveClaudeKey(db: Db, apiKey: string, by: string): void {
  ensureRow(db);
  db.prepare("UPDATE claude_settings SET api_key = ?, key_added_by = ?, key_added_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1").run(apiKey, by);
}

export function saveClaudeModel(db: Db, model: ClaudeModel): void {
  ensureRow(db);
  db.prepare('UPDATE claude_settings SET model = ? WHERE id = 1').run(model);
}

/** The default is saved as NULL, so it follows any later change to the default. */
export function saveFilenamePattern(db: Db, pattern: string): void {
  ensureRow(db);
  db.prepare('UPDATE claude_settings SET filename_pattern = ? WHERE id = 1').run(pattern === DEFAULT_FILENAME_PATTERN ? null : pattern);
}

export function removeClaudeKey(db: Db): void {
  db.prepare('UPDATE claude_settings SET api_key = NULL, key_added_by = NULL, key_added_at = NULL WHERE id = 1').run();
}
