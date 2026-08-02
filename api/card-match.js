// api/card-match.js — Vercel serverless function (FAST path)
// Returns just the Metabase card (question 30460) so the UI can render immediately.
// Card Hedger sales/FMV are fetched separately by /api/card-sales.
//
// Env: METABASE_API_KEY (required), METABASE_URL (optional), CARD_MATCH_CARD_ID (optional, 30460)

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (o, ...targets) => {
  if (!o) return '';
  const keys = Object.keys(o);
  for (const t of targets) { const k = keys.find(k => norm(k) === t); if (k !== undefined && o[k] != null) return o[k]; }
  return '';
};
const hasKey = (o, ...targets) => !!o && Object.keys(o).some(k => targets.includes(norm(k)));
const asBool = v => { if (typeof v === 'boolean') return v; const s = norm(v); return s==='true'||s==='t'||s==='y'||s==='yes'||s==='1'||s==='rookie'; };
const numify = v => { if (v===''||v==null) return ''; const n=Number(String(v).replace(/[^0-9.\-]/g,'')); return isNaN(n)?'':n; };
const gradeDisplay = (c, g) => [String(c||'').trim(), String(g??'').trim()].filter(Boolean).join(' ');
const GRADER_NAMES = { psa:'PSA', bgs:'BGS', sgc:'SGC', cgc:'CGC', csg:'CSG', hga:'HGA', arenaclub:'Arena Club' };
const graderName = c => { const k=norm(c); return GRADER_NAMES[k] || String(c||'').toUpperCase(); };

function normalizeCard(o, certFallback) {
  const company = pick(o, 'gradingcompany', 'grader', 'gradecompany', 'company');
  const grade = pick(o, 'grade');
  const faKey = hasKey(o, 'fullart');
  return {
    category: pick(o,'category','sport')||'',
    ac_number: pick(o,'acnumber','ac','8ac','ac_number')||'',
    language: pick(o,'language','lang')||'',
    cert: String(pick(o,'certnumber','cert','certno')||certFallback||''),
    grade: grade||'',
    grading_company: company||'',
    grade_display: gradeDisplay(company?graderName(company):'', grade),
    set_name: pick(o,'setname','set')||'',
    set_id: pick(o,'setid')||'',
    subset: pick(o,'subset','settype')||'',
    insert: pick(o,'insertname','insert')||'',
    insert_id: pick(o,'insertid')||'',
    extra: pick(o,'extra')||'',
    player: pick(o,'playername','player','character','subject')||'',
    card_no: pick(o,'cardno','cardnumber','number')||'',
    has_rookie: hasKey(o,'rookie','isrookie'),
    rookie: asBool(pick(o,'rookie','isrookie')),
    variant: pick(o,'variant')||'',
    finish: pick(o,'finish','foil','holo','holofoil','reverseholo')||'',
    full_art: faKey ? (asBool(pick(o,'fullart'))?'Yes':'No') : '',
    rarity: pick(o,'rarity')||'',
    edition: pick(o,'edition')||'',
    parallel: pick(o,'parallelname','parallel')||'',
    parallel_total: pick(o,'paralleltotal')||'',
    tag: pick(o,'tag')||'',
    admin_url: pick(o,'url','adminurl')||'',
    estimate_value: pick(o,'estimatedvalue','estimate','estimatevalue','estvalue','estimatedprice','estimatedmarketvalue','marketvalue','valuation','value') ?? '',
    image: pick(o,'frontslabpictureurl','slabpictureurl','frontpictureurl','pictureurl','imageurl','image','cardimage','frontimage','imagefront','img')||''
  };
}

let metaCache = null;
async function metabaseParams(BASE, KEY, CARD) {
  if (metaCache) return metaCache;
  const r = await fetch(`${BASE}/api/card/${CARD}`, { headers: { 'x-api-key': KEY } });
  if (!r.ok) throw new Error('card meta ' + r.status);
  const j = await r.json();
  metaCache = {}; (j.parameters||[]).forEach(p => { if (p.slug) metaCache[p.slug] = p; });
  return metaCache;
}
async function queryMetabase(BASE, KEY, CARD, filters) {
  const defs = await metabaseParams(BASE, KEY, CARD);
  const parameters = [];
  for (const [slug, value] of Object.entries(filters)) {
    if (value===''||value==null) continue;
    const p = defs[slug]; if (!p) continue;
    parameters.push({ id: p.id, type: p.type, target: p.target, value });
  }
  const r = await fetch(`${BASE}/api/card/${CARD}/query/json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ parameters })
  });
  if (!r.ok) throw new Error('metabase query ' + r.status);
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

export default async function handler(req, res) {
  const BASE = (process.env.METABASE_URL || 'https://arena-club.metabaseapp.com').replace(/\/+$/, '');
  const CARD = process.env.CARD_MATCH_CARD_ID || '30460';
  const KEY = process.env.METABASE_API_KEY;
  const q = req.query || {};
  const cert = String(q.cert_number || q.cert || '').replace(/\D/g, '');
  const ac = String(q.ac_number || q.ac || '').trim();
  if (!cert && !ac) { res.status(400).json({ error: 'cert_number or ac_number is required' }); return; }
  if (!KEY) { res.status(500).json({ error: 'METABASE_API_KEY is not set' }); return; }

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  try {
    const filters = cert ? { cert_number: cert } : { ac_number: ac };
    const rows = await queryMetabase(BASE, KEY, CARD, filters);
    if (rows.length) {
      const card = normalizeCard(rows[0], cert);
      const mbVal = numify(card.estimate_value);
      card.estimate = mbVal !== '' ? { value: mbVal, low: '', high: '', confidence: '', method: 'metabase' } : null;
      res.status(200).json({ source: 'metabase', card });
      return;
    }
  } catch (e) {}
  res.status(200).json({ source: 'none' });
}
