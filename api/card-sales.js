// api/card-sales.js — Vercel serverless function (Card Hedger sales + FMV)
// Fetched separately from /api/card-match so the card renders first and sales stream in.
// Runs comps-by-cert and fmv-by-cert in parallel. Optionally returns a fallback card.
//
// Env: CARDHEDGE_API_KEY (or X-CH-Key header / ?chkey=), CARDHEDGE_URL (optional).

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (o, ...targets) => {
  if (!o) return '';
  const keys = Object.keys(o);
  for (const t of targets) { const k = keys.find(k => norm(k) === t); if (k !== undefined && o[k] != null) return o[k]; }
  return '';
};
const asBool = v => { if (typeof v === 'boolean') return v; const s = norm(v); return s==='true'||s==='t'||s==='y'||s==='yes'||s==='1'||s==='rookie'; };
const numify = v => { if (v===''||v==null) return ''; const n=Number(String(v).replace(/[^0-9.\-]/g,'')); return isNaN(n)?'':n; };
const norm4 = d => String(d || '').slice(0, 10);
const gradeDisplay = (c, g) => [String(c||'').trim(), String(g??'').trim()].filter(Boolean).join(' ');

function normalizeCardFromComps(data, cert) {
  const c = data && data.card; const ci = (data && data.cert_info) || {};
  if (!c && !ci.grade) return null;
  const o = Object.assign({}, c || {});
  return {
    category: pick(o,'category')||'',
    ac_number: '', language: '',
    cert: String(ci.cert || cert || ''),
    grade: '', grading_company: '',
    grade_display: gradeDisplay('', ci.grade || ''),
    set_name: pick(o,'set')||'',
    set_id: '',
    subset: pick(o,'settype')||'',
    insert: '', insert_id: '', extra: '',
    player: pick(o,'player')||'',
    card_no: pick(o,'number')||'',
    has_rookie: Object.keys(o).some(k=>norm(k)==='rookie'),
    rookie: asBool(pick(o,'rookie')),
    variant: pick(o,'variant')||'',
    full_art: '', rarity: '', edition: '',
    parallel: '', parallel_total: '', tag: '', admin_url: '',
    estimate_value: '',
    image: pick(o,'image')||''
  };
}

function salesFromComps(data) {
  if (!data) return null;
  const raw = Array.isArray(data.sales) ? data.sales : [];
  const recent = raw.map(s => ({
    date: norm4(pick(s,'saledate','date')),
    price: numify(pick(s,'price','amount')),
    grade: String(pick(s,'grade')||''),
    source: String(pick(s,'pricesource','source','marketplace')||''),
    type: String(pick(s,'saletype','type')||''),
    url: String(pick(s,'saleurl','url')||'')
  })).filter(s => s.price !== '' || s.date);
  const summary = {
    comp: numify(data.comp_price != null ? data.comp_price : pick(data,'compprice')),
    high: numify(data.high), low: numify(data.low),
    count: numify(data.total_count != null ? data.total_count : pick(data,'totalcount','countused')),
    last: recent.length ? (recent.map(r=>r.price).find(p=>p!=='') ?? '') : ''
  };
  const hasSummary = ['comp','high','low','count','last'].some(k => summary[k] !== '');
  if (!recent.length && !hasSummary) return null;
  return { summary: hasSummary ? summary : null, recent };
}

async function chFetch(path, body, KEY, BASE) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    body: JSON.stringify(body)
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  const BASE = (process.env.CARDHEDGE_URL || 'https://api.cardhedger.com').replace(/\/+$/, '');
  const q = req.query || {};
  const KEY = (req.headers && req.headers['x-ch-key']) || q.chkey || process.env.CARDHEDGE_API_KEY;
  const cert = String(q.cert_number || q.cert || '').replace(/\D/g, '');
  const grader = String(q.grader || 'PSA').toUpperCase();
  const needCard = !!(q.need_card);

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  if (!cert || !KEY) { res.status(200).json({ sales: null, estimate: null, card: null }); return; }

  let comps = null;
  try { comps = await chFetch('/v1/cards/comps-by-cert', { cert_number: cert, grading_company: grader, limit: 25, offset: 0 }, KEY, BASE); } catch (e) {}

  const sales = comps ? salesFromComps(comps) : null;
  const card = (needCard && comps) ? normalizeCardFromComps(comps, cert) : null;
  const chCard = comps && comps.card ? comps.card : null;
  const ci = comps && comps.cert_info ? comps.cert_info : null;
  const ch_variant = chCard ? String(chCard.variant || '') : '';
  const ch_desc = chCard ? String(chCard.description || '') : '';
  const ch_cert_desc = ci ? String(ci.description || '') : '';

  res.status(200).json({ sales, estimate: null, card, ch_variant, ch_desc, ch_cert_desc });
}
