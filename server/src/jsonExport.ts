import type { Response } from 'express';

/**
 * JSON exports sit beside the CSV ones and take the same query. Unlike CSV they
 * keep the structure (an expense's line items, say). Money stays in integer
 * pence, in fields ending `Pence`; dates are ISO. The one exception is the MTD
 * quarter, which is HMRC's own payload, in pounds.
 */
export function sendJsonExport(res: Response, filename: string, body: Record<string, unknown>): void {
  res
    .attachment(filename)
    .type('application/json')
    .send(`${JSON.stringify({ exportedAt: new Date().toISOString(), ...body }, null, 2)}\n`);
}
