// AI document scanning settings (one row in ai_settings): which AI reads documents, each provider's
// key and model, and how read documents are named. Keys are never sent to a browser.
import {
  AI_PROVIDER_INFO,
  AI_PROVIDERS,
  apiKeyHint,
  DEFAULT_FILENAME_PATTERN,
  filenamePatternProblem,
  isAiModel,
  isAiProvider,
  type AiModel,
  type AiProvider,
  type AiStatus,
} from '@crafty/shared';
import type { Db } from './db';

/** Each provider's columns. Fixed names, so safe to put into SQL. */
const COLUMNS = {
  claude: { key: 'claude_api_key', by: 'claude_key_added_by', at: 'claude_key_added_at', model: 'claude_model' },
  gemini: { key: 'gemini_api_key', by: 'gemini_key_added_by', at: 'gemini_key_added_at', model: 'gemini_model' },
} as const satisfies Record<AiProvider, Record<string, string>>;

export interface AiProviderSettings {
  apiKey: string | null;
  model: AiModel;
  keyAddedBy: string | null;
  keyAddedAt: string | null;
}

export interface AiSettings {
  provider: AiProvider;
  providers: Record<AiProvider, AiProviderSettings>;
  filenamePattern: string;
}

/** The AI that reads documents, with its key: null while it has no key, so documents wait. */
export interface ActiveReader {
  provider: AiProvider;
  apiKey: string;
  model: AiModel;
}

export function getAiSettings(db: Db): AiSettings {
  const row = db.prepare('SELECT * FROM ai_settings WHERE id = 1').get() as Record<string, string | null> | undefined;
  const providerSettings = (p: AiProvider): AiProviderSettings => {
    const c = COLUMNS[p];
    const apiKey = row?.[c.key] ?? null;
    const model = row?.[c.model];
    return {
      apiKey,
      model: isAiModel(p, model) ? model : AI_PROVIDER_INFO[p].defaultModel,
      keyAddedBy: apiKey ? (row?.[c.by] ?? null) : null,
      keyAddedAt: apiKey ? (row?.[c.at] ?? null) : null,
    };
  };
  const pattern = row?.filename_pattern;
  return {
    provider: isAiProvider(row?.provider) ? row.provider : 'claude',
    providers: { claude: providerSettings('claude'), gemini: providerSettings('gemini') },
    filenamePattern: pattern && !filenamePatternProblem(pattern) ? pattern : DEFAULT_FILENAME_PATTERN,
  };
}

export function activeReader(db: Db): ActiveReader | null {
  const s = getAiSettings(db);
  const { apiKey, model } = s.providers[s.provider];
  return apiKey ? { provider: s.provider, apiKey, model } : null;
}

export function aiStatus(db: Db): AiStatus {
  const s = getAiSettings(db);
  const providers = Object.fromEntries(
    AI_PROVIDERS.map((p) => {
      const { apiKey, model, keyAddedBy, keyAddedAt } = s.providers[p];
      return [p, { configured: apiKey !== null, keyHint: apiKey ? apiKeyHint(apiKey) : null, keyAddedBy, keyAddedAt, model }];
    }),
  ) as AiStatus['providers'];
  return { provider: s.provider, configured: providers[s.provider].configured, providers, filenamePattern: s.filenamePattern };
}

const ensureRow = (db: Db) => db.prepare('INSERT OR IGNORE INTO ai_settings (id) VALUES (1)').run();

export function saveProvider(db: Db, provider: AiProvider): void {
  ensureRow(db);
  db.prepare('UPDATE ai_settings SET provider = ? WHERE id = 1').run(provider);
}

export function saveAiKey(db: Db, provider: AiProvider, apiKey: string, by: string): void {
  const c = COLUMNS[provider];
  ensureRow(db);
  db.prepare(`UPDATE ai_settings SET ${c.key} = ?, ${c.by} = ?, ${c.at} = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1`).run(apiKey, by);
}

export function saveAiModel(db: Db, provider: AiProvider, model: AiModel): void {
  ensureRow(db);
  db.prepare(`UPDATE ai_settings SET ${COLUMNS[provider].model} = ? WHERE id = 1`).run(model);
}

/** The default is saved as NULL, so it follows any later change to the default. */
export function saveFilenamePattern(db: Db, pattern: string): void {
  ensureRow(db);
  db.prepare('UPDATE ai_settings SET filename_pattern = ? WHERE id = 1').run(pattern === DEFAULT_FILENAME_PATTERN ? null : pattern);
}

export function removeAiKey(db: Db, provider: AiProvider): void {
  const c = COLUMNS[provider];
  db.prepare(`UPDATE ai_settings SET ${c.key} = NULL, ${c.by} = NULL, ${c.at} = NULL WHERE id = 1`).run();
}
