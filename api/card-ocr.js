// api/card-ocr.js — Vercel serverless function
// Reads a graded-slab image with Card Hedger's AI vision OCR and returns the
// detected cert + grader, which the app then feeds into its normal card match.
//
// Card Hedger: POST /v1/cards/details-by-cert-ocr  { image_base64 | image_url }  (X-API-Key)
// Shared 2000/day OCR cap across the two OCR endpoints (resets 00:00 UTC).
//
// Env: CARDHEDGE_API_KEY (required), CARDHEDGE_URL (optional, default https://api.cardhedger.com)

export default async function handler(req, res) {
  const BASE = (process.env.CARDHEDGE_URL || 'https://api.cardhedger.com').replace(/\/+$/, '');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const KEY = (req.headers && req.headers['x-ch-key']) || (body && body.chkey) || process.env.CARDHEDGE_API_KEY;
  if (!KEY) { res.status(500).json({ error: 'CARDHEDGE_API_KEY is not set' }); return; }
  const image = (body && (body.image || body.image_base64 || body.image_url)) || '';
  if (!image) { res.status(400).json({ error: 'image is required' }); return; }

  const payload = /^https?:\/\//.test(image) ? { image_url: image } : { image_base64: image };

  try {
    const r = await fetch(`${BASE}/v1/cards/details-by-cert-ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      res.status(r.status).json({ error: 'ocr failed', status: r.status, detail });
      return;
    }
    const d = await r.json();
    const ci = d.cert_info || {};
    res.status(200).json({
      cert: String(ci.cert || '').replace(/\D/g, ''),
      grader: String(ci.grader || '').toUpperCase(),
      grade: ci.grade || '',
      card: d.card || null
    });
  } catch (e) {
    res.status(502).json({ error: 'proxy failed', detail: String(e).slice(0, 200) });
  }
}
