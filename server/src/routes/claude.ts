// Settings → Claude Integration: the Anthropic API key (shown only as a hint) and the model.
import { Router } from 'express';
import { claudeSettingsSchema } from '@crafty/shared';
import type { AppContext } from '../context';
import { claudeStatus, getClaudeSettings, removeClaudeKey, saveClaudeKey, saveClaudeModel } from '../claudeSettings';
import { parseWith } from '../http';

export function claudeRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(claudeStatus(ctx.db));
  });

  // A new key is checked with Anthropic before it's saved, against the model it will use.
  router.put('/', async (req, res) => {
    const input = parseWith(claudeSettingsSchema, req.body);
    const model = input.model ?? getClaudeSettings(ctx.db).model;
    if (input.apiKey) await ctx.claude.checkKey(input.apiKey, model);
    ctx.db.transaction(() => {
      if (input.apiKey) saveClaudeKey(ctx.db, input.apiKey, req.user!.name);
      if (input.model) saveClaudeModel(ctx.db, input.model);
    })();
    res.json(claudeStatus(ctx.db));
  });

  router.delete('/key', (_req, res) => {
    removeClaudeKey(ctx.db);
    res.json(claudeStatus(ctx.db));
  });

  return router;
}
