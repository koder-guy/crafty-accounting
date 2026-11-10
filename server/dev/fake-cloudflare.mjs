// A stand-in for Cloudflare's API, for trying Settings → HTTPS Certificate → Domain on Cloudflare
// without a Cloudflare account. Run it, then start the server with CLOUDFLARE_API_URL=http://localhost:3198
// (api-check-cloudflare in .claude/launch.json). It has one zone, example.co.uk, and takes any token
// of the right shape except ones containing "bad".
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3198);
let records = [{ id: 'theirs', type: 'A', name: 'www.example.co.uk', content: '203.0.113.9', proxied: true }];
let next = 1;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const reply = (status, result) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status < 400 ? { success: true, errors: [], result } : { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }));
    };
    const auth = req.headers.authorization ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{30,}$/.test(auth) || auth.includes('bad')) return reply(401);
    if (url.pathname === '/zones') return reply(200, url.searchParams.get('name') === 'example.co.uk' ? [{ id: 'zone-1', name: 'example.co.uk' }] : []);
    const m = /^\/zones\/zone-1\/dns_records(?:\/(.+))?$/.exec(url.pathname);
    if (!m) return reply(404);
    if (req.method === 'GET') return reply(200, records.filter((r) => r.name === url.searchParams.get('name')));
    if (req.method === 'POST') {
      const record = { id: `rec-${next++}`, type: body.type, name: body.name, content: body.content, proxied: !!body.proxied };
      records.push(record);
      console.log('Made', record);
      return reply(200, record);
    }
    const record = records.find((r) => r.id === m[1]);
    if (!record) return reply(404);
    if (req.method === 'PATCH') {
      record.content = body.content;
      console.log('Changed', record);
      return reply(200, record);
    }
    records = records.filter((r) => r !== record);
    console.log('Removed', record);
    return reply(200, { id: record.id });
  })
  .listen(PORT, () => console.log(`Fake Cloudflare on http://localhost:${PORT}`));
