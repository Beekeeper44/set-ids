// api/set-ids.js — Vercel serverless function
// Proxies Metabase question 21088 ("set-ids") so the browser never sees the API key
// and there are no CORS problems (the app calls this same-origin route instead of Metabase).
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   METABASE_API_KEY   (required)  a Metabase API key with access to the question
//   METABASE_URL       (optional)  default: https://arena-club.metabaseapp.com
//   METABASE_CARD_ID   (optional)  default: 21088

export default async function handler(req, res) {
  const BASE = (process.env.METABASE_URL || 'https://arena-club.metabaseapp.com').replace(/\/+$/, '');
  const CARD = process.env.METABASE_CARD_ID || '21088';
  const KEY  = process.env.METABASE_API_KEY;

  if (!KEY) {
    res.status(500).json({ error: 'METABASE_API_KEY is not set in this Vercel project.' });
    return;
  }

  try {
    // Metabase JSON export of the saved question. Empty parameters = fetch all rows;
    // the front-end handles sport/brand/year/search filtering client-side.
    const mb = await fetch(`${BASE}/api/card/${CARD}/query/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify({ parameters: [] })
    });

    if (!mb.ok) {
      const detail = (await mb.text()).slice(0, 500);
      res.status(mb.status).json({ error: 'Metabase request failed', status: mb.status, detail });
      return;
    }

    const raw = await mb.json();

    // Normalize column keys (case/format-insensitive) into the stable shape the app expects.
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const pick = (o, ...targets) => {
      const keys = Object.keys(o);
      for (const t of targets) {
        const k = keys.find(k => norm(k) === t);
        if (k !== undefined) return o[k];
      }
      return '';
    };

    const rows = (Array.isArray(raw) ? raw : []).map(o => ({
      sport:          pick(o, 'sport'),
      brand:          pick(o, 'brand'),
      year:           pick(o, 'year'),
      set_name:       pick(o, 'setname', 'set'),
      code:           pick(o, 'code'),
      set_id:         pick(o, 'setid'),
      set_created_at: pick(o, 'setcreatedat', 'createdat', 'created')
    }));

    // Cache at Vercel's edge for a minute; serve stale up to 5 min while revalidating.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json(rows);
  } catch (e) {
    res.status(502).json({ error: 'Proxy failed to reach Metabase', detail: String(e).slice(0, 300) });
  }
}
