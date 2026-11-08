// Reading invoices with Gemini, through Google's Gemini API. Same prompt and reply schema as Claude:
// the schema goes as `responseJsonSchema`, so the reply is JSON in that shape.
import { ApiError, FinishReason, GoogleGenAI } from '@google/genai';
import { HttpError } from '../http';
import { outputSchema, readRequest, SYSTEM, toInvoiceReading, type DocumentReader } from '../invoiceReader';

/** Google answers a key it doesn't know with 400 (INVALID_ARGUMENT) rather than 401. */
const isKeyProblem = (err: ApiError) => err.status === 401 || err.status === 403 || (err.status === 400 && /api[ _]key/i.test(err.message));

/** Turns the SDK's errors into ones the app can show. Never 401: the client would take it as being signed out. */
function apiError(err: unknown): never {
  if (err instanceof ApiError) {
    if (isKeyProblem(err)) throw new HttpError(502, 'Google refused the API key saved in Settings → AI Document Scanning.');
    if (err.status === 429) throw new HttpError(503, 'The Gemini API is busy or the key is over its limits. Try again later.');
    if (err.status === 400) throw new HttpError(422, `Gemini couldn't read that file: ${err.message}`);
    throw new HttpError(502, `The Gemini API didn't answer properly (${err.status}). Try again later.`);
  }
  throw err;
}

export const geminiReader: DocumentReader = {
  async checkKey(apiKey, model) {
    try {
      await new GoogleGenAI({ apiKey }).models.get({ model });
    } catch (err) {
      if (err instanceof ApiError) {
        if (isKeyProblem(err)) throw new HttpError(422, 'Google didn\'t accept that key. Check you copied all of it, and that the Gemini API is enabled for its project.');
        if (err.status === 404) throw new HttpError(422, 'That key can\'t use the chosen model. Try another model.');
        apiError(err);
      }
      throw new HttpError(502, 'Couldn\'t reach Google to check the key. Check the server is online.');
    }
  },

  async readInvoice(apiKey, model, { data, mediaType, categories }) {
    const ai = new GoogleGenAI({ apiKey });
    let response;
    try {
      response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mediaType, data: data.toString('base64') } }, { text: readRequest(categories) }] }],
        config: {
          systemInstruction: SYSTEM,
          maxOutputTokens: 16000,
          responseMimeType: 'application/json',
          responseJsonSchema: outputSchema(categories.map((c) => String(c.id))),
        },
      });
    } catch (err) {
      apiError(err);
    }

    if (response.promptFeedback?.blockReason) throw new HttpError(422, 'Gemini declined to read this document.');
    const finish = response.candidates?.[0]?.finishReason;
    if (finish === FinishReason.MAX_TOKENS) throw new HttpError(422, 'The invoice was too long to read in one go.');
    if (finish && finish !== FinishReason.STOP) throw new HttpError(422, 'Gemini declined to read this document.');
    let reply: unknown;
    try {
      reply = JSON.parse(response.text ?? '');
    } catch {
      reply = null;
    }
    return toInvoiceReading(reply, categories, 'gemini');
  },
};
