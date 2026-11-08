// AI document scanning (Settings → AI Document Scanning): which AI reads invoices, Claude (Anthropic) or
// Gemini (Google), each with its own API key and model, and how the documents read are named.
import { z } from 'zod';
import { filenamePatternProblem } from './invoiceFilename';

export const AI_PROVIDERS = ['claude', 'gemini'] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

export const isAiProvider = (value: unknown): value is AiProvider => AI_PROVIDERS.includes(value as AiProvider);

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'Most accurate, for messy or hard-to-read invoices. About 2–4p an invoice.' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'Nearly as good for invoices, at about half the price. About 1–2p an invoice.' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'Cheapest; fine for clear, printed invoices. Well under 1p an invoice.' },
] as const;

export const GEMINI_MODELS = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', note: 'Accurate for most invoices. About 1p an invoice.' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', note: 'Cheapest; fine for clear, printed invoices. Well under 1p an invoice.' },
] as const;

export type ClaudeModel = (typeof CLAUDE_MODELS)[number]['id'];
export type GeminiModel = (typeof GEMINI_MODELS)[number]['id'];
export type AiModel = ClaudeModel | GeminiModel;

/** What the settings page says about each provider. */
export const AI_PROVIDER_INFO = {
  claude: {
    name: 'Claude',
    company: 'Anthropic',
    models: CLAUDE_MODELS,
    /** For a new install. Installs from before it changed keep Opus (migration 21). */
    defaultModel: 'claude-haiku-5-5' as ClaudeModel,
    keyPlaceholder: 'sk-ant-…',
    console: { name: 'Anthropic Console', url: 'https://console.anthropic.com/settings/keys' },
    billing: 'Anthropic bills it per use, separately from a Claude subscription.',
    privacy: 'Anthropic doesn\'t use what the API is sent to train its models.',
  },
  gemini: {
    name: 'Gemini',
    company: 'Google',
    models: GEMINI_MODELS,
    defaultModel: 'gemini-3.8-flash' as GeminiModel,
    keyPlaceholder: 'AIza…',
    console: { name: 'Google AI Studio', url: 'https://aistudio.google.com/apikey' },
    billing: 'Google bills it per use once billing is set up for its project; without billing it\'s on the free tier, with low limits.',
    privacy: 'On Google\'s free tier, what\'s sent may be used to improve Google\'s products. Set up billing for the key\'s project so invoices aren\'t.',
  },
} as const;

export const AI_MODEL_IDS = {
  claude: CLAUDE_MODELS.map((m) => m.id) as [ClaudeModel, ...ClaudeModel[]],
  gemini: GEMINI_MODELS.map((m) => m.id) as [GeminiModel, ...GeminiModel[]],
};

export function isAiModel<P extends AiProvider>(provider: P, value: unknown): value is (typeof AI_MODEL_IDS)[P][number] {
  return (AI_MODEL_IDS[provider] as readonly unknown[]).includes(value);
}

/** Choosing which AI reads documents, or how the documents read are named, or both. */
export const aiSettingsSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS, 'Choose Claude or Gemini').optional(),
    /** How documents read are named (`invoiceFilename`). */
    filenamePattern: z
      .string()
      .superRefine((value, ctx) => {
        const problem = filenamePatternProblem(value);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      })
      .optional(),
  })
  .refine((v) => v.provider !== undefined || v.filenamePattern !== undefined, 'Nothing to save');

export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;

const apiKeySchema = z
  .string()
  .trim()
  .min(1, 'Enter the API key')
  .max(500, 'That is too long for an API key')
  .regex(/^\S+$/, 'An API key has no spaces in it');

/** Saving one provider's key, model, or both. The key itself is never sent back. */
export function aiProviderSettingsSchema<P extends AiProvider>(provider: P) {
  return z
    .object({ apiKey: apiKeySchema.optional(), model: z.enum(AI_MODEL_IDS[provider] as [string, ...string[]], 'Choose a model').optional() })
    .refine((v) => v.apiKey !== undefined || v.model !== undefined, 'Nothing to save');
}

export interface AiProviderSettingsInput {
  apiKey?: string;
  model?: AiModel;
}

/** Enough of a key to recognise it: its start and last four characters. */
export function apiKeyHint(key: string): string {
  return key.length > 20 ? `${key.slice(0, 10)}…${key.slice(-4)}` : `…${key.slice(-4)}`;
}

export interface AiProviderStatus {
  /** A key is saved. */
  configured: boolean;
  keyHint: string | null;
  /** Who added the key, and when. */
  keyAddedBy: string | null;
  keyAddedAt: string | null;
  model: AiModel;
}

export interface AiStatus {
  /** The AI that reads documents. */
  provider: AiProvider;
  /** Its key is saved, so documents can be read. */
  configured: boolean;
  providers: Record<AiProvider, AiProviderStatus>;
  /** How documents read are named, such as {date}_{payee}_{invoice}_£{amount}. */
  filenamePattern: string;
}
