// The Claude integration (Settings → Claude Integration): an Anthropic API key and the model that reads invoices.
import { z } from 'zod';
import { filenamePatternProblem } from './invoiceFilename';

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'Most accurate, for messy or hard-to-read invoices. About 2–4p an invoice.' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'Nearly as good for invoices, at about half the price. About 1–2p an invoice.' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'Cheapest; fine for clear, printed invoices. Well under 1p an invoice.' },
] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number]['id'];

export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-opus-5-5';

const MODEL_IDS = CLAUDE_MODELS.map((m) => m.id) as [ClaudeModel, ...ClaudeModel[]];

export const isClaudeModel = (value: unknown): value is ClaudeModel => MODEL_IDS.includes(value as ClaudeModel);

/** Saving the settings: a new key, a model, the filename pattern, or any of them. The key itself is never sent back. */
export const claudeSettingsSchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(1, 'Enter the API key')
      .max(500, 'That is too long for an API key')
      .regex(/^\S+$/, 'An API key has no spaces in it')
      .optional(),
    model: z.enum(MODEL_IDS, 'Choose a model').optional(),
    /** How documents Claude read are named (`invoiceFilename`). */
    filenamePattern: z
      .string()
      .superRefine((value, ctx) => {
        const problem = filenamePatternProblem(value);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      })
      .optional(),
  })
  .refine((v) => v.apiKey !== undefined || v.model !== undefined || v.filenamePattern !== undefined, 'Nothing to save');

export type ClaudeSettingsInput = z.infer<typeof claudeSettingsSchema>;

/** Enough of a key to recognise it: its start and last four characters. */
export function claudeKeyHint(key: string): string {
  return key.length > 20 ? `${key.slice(0, 10)}…${key.slice(-4)}` : `…${key.slice(-4)}`;
}

export interface ClaudeStatus {
  /** A key is saved, so invoices can be read. */
  configured: boolean;
  keyHint: string | null;
  /** Who added the key, and when. */
  keyAddedBy: string | null;
  keyAddedAt: string | null;
  model: ClaudeModel;
  /** How documents Claude read are named, such as {date}_{payee}_{invoice}_£{amount}. */
  filenamePattern: string;
}
