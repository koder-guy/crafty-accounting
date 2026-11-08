// Settings → AI Document Scanning: which AI reads documents, each one's API key (shown only as a
// hint) and model, and how read documents are named.
import { Router } from 'express';
import { aiProviderSettingsSchema, aiSettingsSchema, isAiProvider, type AiModel, type AiProvider } from '@crafty/shared';
import type { AppContext } from '../context';
import { aiStatus, getAiSettings, removeAiKey, saveAiKey, saveAiModel, saveFilenamePattern, saveProvider } from '../aiSettings';
import { HttpError, parseWith } from '../http';

function providerParam(value: string): AiProvider {
  if (!isAiProvider(value)) throw new HttpError(404, 'Not found');
  return value;
}

export function aiRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(aiStatus(ctx.db));
  });

  router.put('/', (req, res) => {
    const input = parseWith(aiSettingsSchema, req.body);
    ctx.db.transaction(() => {
      if (input.provider) saveProvider(ctx.db, input.provider);
      if (input.filenamePattern !== undefined) saveFilenamePattern(ctx.db, input.filenamePattern);
    })();
    // Documents left waiting may be readable now.
    ctx.scans.kick();
    res.json(aiStatus(ctx.db));
  });

  // A new key is checked with its provider before it's saved, against the model it will use.
  router.put('/:provider', async (req, res) => {
    const provider = providerParam(req.params.provider);
    const input = parseWith(aiProviderSettingsSchema(provider), req.body);
    const model = (input.model as AiModel | undefined) ?? getAiSettings(ctx.db).providers[provider].model;
    if (input.apiKey) await ctx.readers[provider].checkKey(input.apiKey, model);
    ctx.db.transaction(() => {
      if (input.apiKey) saveAiKey(ctx.db, provider, input.apiKey, req.user!.name);
      if (input.model) saveAiModel(ctx.db, provider, model);
    })();
    ctx.scans.kick();
    res.json(aiStatus(ctx.db));
  });

  router.delete('/:provider/key', (req, res) => {
    removeAiKey(ctx.db, providerParam(req.params.provider));
    res.json(aiStatus(ctx.db));
  });

  return router;
}
