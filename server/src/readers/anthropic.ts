// Reading invoices with Claude, through the Anthropic API.
import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from '../http';
import { outputSchema, readRequest, SYSTEM, toInvoiceReading, type DocumentReader } from '../invoiceReader';

/** Turns the SDK's errors into ones the app can show. Never 401: the client would take it as being signed out. */
function apiError(err: unknown): never {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    throw new HttpError(502, 'Anthropic refused the API key saved in Settings → AI Document Scanning.');
  }
  if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'The Anthropic API is busy or the account is out of credit. Try again later.');
  if (err instanceof Anthropic.BadRequestError) throw new HttpError(422, `Claude couldn't read that file: ${err.message}`);
  if (err instanceof Anthropic.APIError) throw new HttpError(502, `The Anthropic API didn't answer properly (${err.status ?? 'no connection'}). Try again later.`);
  throw err;
}

export const anthropicReader: DocumentReader = {
  async checkKey(apiKey, model) {
    try {
      await new Anthropic({ apiKey, maxRetries: 0 }).models.retrieve(model);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new HttpError(422, 'Anthropic didn\'t accept that key. Check you copied all of it.');
      if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
        throw new HttpError(422, 'That key can\'t use the chosen model. Try another model, or check the key\'s workspace in the Anthropic Console.');
      }
      if (err instanceof Anthropic.APIConnectionError) throw new HttpError(502, 'Couldn\'t reach Anthropic to check the key. Check the server is online.');
      apiError(err);
    }
  },

  async readInvoice(apiKey, model, { data, mediaType, categories }) {
    if (mediaType === 'image/heic' || mediaType === 'image/heif') throw new HttpError(422, 'Claude can\'t read HEIC photos.');
    const client = new Anthropic({ apiKey });
    const source = { type: 'base64' as const, data: data.toString('base64') };
    const document =
      mediaType === 'application/pdf'
        ? { type: 'document' as const, source: { ...source, media_type: mediaType } }
        : { type: 'image' as const, source: { ...source, media_type: mediaType } };

    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // If a safety check declines the request, the API retries it on another model. Haiku has no fallback.
        ...(model === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
        output_config: {
          effort: 'medium',
          format: { type: 'json_schema', schema: outputSchema(categories.map((c) => String(c.id))) },
        },
        system: SYSTEM,
        messages: [{ role: 'user', content: [document, { type: 'text', text: readRequest(categories) }] }],
      });
    } catch (err) {
      apiError(err);
    }

    if (response.stop_reason === 'refusal') throw new HttpError(422, 'Claude declined to read this document.');
    if (response.stop_reason === 'max_tokens') throw new HttpError(422, 'The invoice was too long to read in one go.');
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let reply: unknown;
    try {
      reply = JSON.parse(text);
    } catch {
      reply = null;
    }
    return toInvoiceReading(reply, categories, 'claude');
  },
};
