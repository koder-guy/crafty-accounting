// A stand-in for Square's API, for trying Income → Import from Square without a Square account.
// Run it, then start the server with SQUARE_API_URL=http://localhost:3199 (api-check-square in
// .claude/launch.json) and save any access token in Settings → Square.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3199);
const gbp = (amount) => ({ amount, currency_code: 'GBP' });
const charge = (at, gross) => ({ type: 'CHARGE', at, gross, fee: Math.round(gross * 0.0175) });
const refund = (at, gross) => ({ type: 'REFUND', at, gross: -gross, fee: -Math.round(gross * 0.0175) });

/** Market days this autumn: Saturdays, and some Wednesdays. */
const PAYOUTS = [
  ['po_fake_1', '2026-10-05', [charge('2026-10-03T09:40:00Z', 2400), charge('2026-10-03T11:15:00Z', 4850), charge('2026-10-03T14:05:00Z', 1200)]],
  ['po_fake_2', '2026-10-08', [charge('2026-10-07T10:20:00Z', 3600), charge('2026-10-07T13:00:00Z', 950)]],
  ['po_fake_3', '2026-10-12', [charge('2026-10-10T10:00:00Z', 6200), charge('2026-10-10T12:30:00Z', 1800), refund('2026-10-10T15:10:00Z', 1800)]],
  ['po_fake_4', '2026-10-19', [charge('2026-10-17T09:30:00Z', 5400), { type: 'RESERVE_HOLD', at: '2026-10-17T18:00:00Z', gross: -1000, fee: 0 }]],
  ['po_fake_5', '2026-10-26', [charge('2026-10-24T10:45:00Z', 7300), charge('2026-10-24T22:30:00Z', 1500)]],
  ['po_fake_6', '2026-11-02', [charge('2026-10-31T11:00:00Z', 8800), charge('2026-11-01T11:00:00Z', 2600)]],
].map(([id, arrival_date, entries]) => ({ id, arrival_date, entries, amount: entries.reduce((a, e) => a + e.gross - e.fee, 0) }));

const asPayout = (p) => ({ id: p.id, status: 'PAID', location_id: 'L_FAKE', amount_money: gbp(p.amount), arrival_date: p.arrival_date, type: 'BATCH' });

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (!/^Bearer \S+$/.test(req.headers.authorization ?? '') || req.headers.authorization.includes('bad')) {
      return send(401, { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] });
    }
    const path = url.pathname;
    if (path === '/v2/merchants/me') return send(200, { merchant: { id: 'M_FAKE', business_name: 'Hedgerow Crafts (fake Square)', currency: 'GBP', country: 'GB' } });
    if (path === '/v2/locations') return send(200, { locations: [{ id: 'L_FAKE', name: 'Market stall' }] });
    if (path === '/v2/payouts') {
      const begin = url.searchParams.get('begin_time') ?? '';
      return send(200, { payouts: PAYOUTS.filter((p) => `${p.arrival_date}T00:00:00Z` >= begin).reverse().map(asPayout) });
    }
    const m = path.match(/^\/v2\/payouts\/([^/]+)(\/payout-entries)?$/);
    const p = m && PAYOUTS.find((x) => x.id === m[1]);
    if (!p) return send(404, { errors: [{ code: 'NOT_FOUND', detail: 'Not found' }] });
    if (!m[2]) return send(200, { payout: asPayout(p) });
    return send(200, {
      payout_entries: p.entries.map((e, i) => ({
        id: `poe_${p.id}_${i}`,
        payout_id: p.id,
        type: e.type,
        effective_at: e.at,
        gross_amount_money: gbp(e.gross),
        fee_amount_money: gbp(e.fee),
        net_amount_money: gbp(e.gross - e.fee),
      })),
    });
  })
  .listen(PORT, () => console.log(`Fake Square on http://localhost:${PORT}`));
