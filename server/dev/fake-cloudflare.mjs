// A stand-in for Cloudflare's API, for trying Settings → HTTPS Certificate → Domain on Cloudflare
// without a Cloudflare account. Run it, then start the server with CLOUDFLARE_API_URL=http://localhost:3198
// (api-check-cloudflare in .claude/launch.json). It has one zone, example.co.uk, and takes any token
// of the right shape except ones containing "bad", and "nodns" ones can't read the zone's DNS.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 3198);
const records = [{ id: 'rec-1', type: 'A', name: 'books.example.co.uk', content: '192.168.1.50', proxied: false }];

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const reply = (status, result) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status < 400 ? { success: true, errors: [], result } : { success: false, errors: [status === 403 ? { code: 10000, message: 'Authentication error' } : { code: 1000, message: 'Invalid API Token' }] }));
    };
    const auth = req.headers.authorization ?? '';
    if (!/^Bearer [A-Za-z0-9_-]{30,}$/.test(auth) || auth.includes('bad')) return reply(401);
    if (url.pathname === '/zones') return reply(200, url.searchParams.get('name') === 'example.co.uk' ? [{ id: 'zone-1', name: 'example.co.uk' }] : []);
    if (url.pathname !== '/zones/zone-1/dns_records') return reply(404);
    if (auth.includes('nodns')) return reply(403);
    return reply(200, records.filter((r) => r.name === url.searchParams.get('name')));
  })
  .listen(PORT, () => console.log(`Fake Cloudflare on http://localhost:${PORT}`));
