// api/ch-test.js — Card Hedger connectivity diagnostic.
// Hit /api/ch-test?cert=137978341&grader=PSA on your deployment to see exactly
// what Card Hedger returns (status + body). Tells key vs cert vs data problems apart.
export default async function handler(req, res) {
  const BASE = (process.env.CARDHEDGE_URL || 'https://api.cardhedger.com').replace(/\/+$/, '');
  const q = req.query || {};
  const KEY = (req.headers && req.headers['x-ch-key']) || q.chkey || process.env.CARDHEDGE_API_KEY;
  const cert = String(q.cert || q.cert_number || '137978341').replace(/\D/g, '');
  const grader = String(q.grader || 'PSA').toUpperCase();
  const out = { base: BASE, cardhedge_key_set: !!KEY, key_length: KEY ? KEY.length : 0, cert, grader, tests: {} };
  if (!KEY) { out.hint = 'CARDHEDGE_API_KEY is NOT set in this Vercel project. Add it and redeploy.'; res.status(200).json(out); return; }

  async function call(name, path, body) {
    try {
      const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
        body: JSON.stringify(body)
      });
      const txt = await r.text();
      out.tests[name] = { status: r.status, ok: r.ok, body: txt.slice(0, 700) };
    } catch (e) { out.tests[name] = { error: String(e).slice(0, 200) }; }
  }

  await call('comps_by_cert', '/v1/cards/comps-by-cert', { cert_number: cert, grading_company: grader, limit: 5, offset: 0 });
  await call('fmv_by_cert', '/v1/cards/fmv-by-cert', { cert, grader });

  const c = out.tests.comps_by_cert || {};
  out.hint = c.status === 401 ? 'HTTP 401 → the API key is missing/invalid or wrong header. Re-check CARDHEDGE_API_KEY.'
    : c.status === 404 ? 'HTTP 404 → this cert is not in Card Hedger/GemRate for that grader. Try a known PSA cert, or the card simply has no comps.'
    : c.status === 429 ? 'HTTP 429 → rate/quota hit. Wait and retry.'
    : c.ok ? 'Card Hedger responded OK — if the app still shows no sales, the issue is in mapping; send me this JSON.'
    : 'Unexpected response — send me this JSON.';
  res.status(200).json(out);
}
