// api/card-match.js — Vercel serverless function
// Looks up a graded card by cert number in Metabase question 30460 ("card-match"),
// then pulls comparable sales from Card Hedger to show beside the match. When the card
// isn't in Metabase, Card Hedger's card details are used as a fallback.
// Returns: { source: 'metabase'|'cardhedge'|'none', card: {...with .sales} }
//
// Card Hedger docs: https://api.cardhedger.com/docs   (auth: X-API-Key header)
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   METABASE_API_KEY      (required)  Metabase API key (same one used by /api/set-ids)
//   METABASE_URL          (optional)  default https://arena-club.metabaseapp.com
//   CARD_MATCH_CARD_ID    (optional)  default 30460
//   CARDHEDGE_URL         (optional)  default https://api.cardhedger.com
//   CARDHEDGE_API_KEY     (optional)  Card Hedger key — enables sales + card fallback
//   CARDHEDGE_DEFAULT_GRADER (optional) default PSA

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (o, ...targets) => {
  if (!o) return '';
  const keys = Object.keys(o);
  for (const t of targets) {
    const k = keys.find(k => norm(k) === t);
    if (k !== undefined && o[k] != null) return o[k];
  }
  return '';
};
const hasKey = (o, ...targets) => !!o && Object.keys(o).some(k => targets.includes(norm(k)));
const asBool = v => {
  if (typeof v === 'boolean') return v;
  const s = norm(v);
  return s === 'true' || s === 't' || s === 'y' || s === 'yes' || s === '1' || s === 'rookie';
};
const numify = v => {
  if (v === '' || v == null) return '';
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? '' : n;
};
const gradeDisplay = (company, grade) =>
  [String(company || '').trim(), String(grade ?? '').trim()].filter(Boolean).join(' ');

// Metabase stores grading_company lowercased (psa, csg, arena_club); show it properly.
const GRADER_NAMES = { psa:'PSA', bgs:'BGS', sgc:'SGC', cgc:'CGC', csg:'CSG', hga:'HGA', arenaclub:'Arena Club' };
const graderName = c => { const k = norm(c); return GRADER_NAMES[k] || String(c || '').toUpperCase(); };

// Map a card object (Metabase row, or Card Hedger card+cert_info) into the app's shape.
function normalizeCard(o, certFallback) {
  const company = pick(o, 'gradingcompany', 'grader', 'gradecompany', 'company');
  const grade   = pick(o, 'grade');
  const faKey   = hasKey(o, 'fullart');
  return {
    category:        pick(o, 'category', 'sport') || '',
    ac_number:       pick(o, 'acnumber', 'ac', '8ac', 'ac_number') || '',
    language:        pick(o, 'language', 'lang') || '',
    cert:            String(pick(o, 'certnumber', 'cert', 'certno') || certFallback || ''),
    grade:           grade || '',
    grading_company: company || '',
    grade_display:   gradeDisplay(company ? graderName(company) : '', grade),
    set_name:        pick(o, 'setname', 'set') || '',
    set_id:          pick(o, 'setid') || '',
    subset:          pick(o, 'subset', 'settype') || '',
    insert:          pick(o, 'insertname', 'insert') || '',
    insert_id:       pick(o, 'insertid') || '',
    extra:           pick(o, 'extra') || '',
    player:          pick(o, 'playername', 'player', 'character', 'subject') || '',
    card_no:         pick(o, 'cardno', 'cardnumber', 'number') || '',
    has_rookie:      hasKey(o, 'rookie', 'isrookie'),
    rookie:          asBool(pick(o, 'rookie', 'isrookie')),
    variant:         pick(o, 'variant') || '',
    full_art:        faKey ? (asBool(pick(o, 'fullart')) ? 'Yes' : 'No') : '',
    rarity:          pick(o, 'rarity') || '',
    edition:         pick(o, 'edition') || '',
    parallel:        pick(o, 'parallelname', 'parallel') || '',
    parallel_total:  pick(o, 'paralleltotal') || '',
    tag:             pick(o, 'tag') || '',
    admin_url:       pick(o, 'url', 'adminurl') || '',
    estimate_value:  pick(o, 'estimatedvalue', 'estimate', 'estimatevalue', 'estvalue', 'estimatedprice', 'estimatedmarketvalue', 'marketvalue', 'valuation', 'value') ?? '',
    last_comp:       pick(o, 'lastcompvalue', 'lastcomp') || '',
    image:           pick(o, 'frontslabpictureurl', 'slabpictureurl', 'frontpictureurl', 'pictureurl', 'imageurl', 'image', 'cardimage', 'frontimage', 'imagefront', 'img') || ''
  };
}

const norm4 = d => String(d || '').slice(0, 10);

// ---- Metabase (question 30460) ----
let metaCache = null;
async function metabaseParams(BASE, KEY, CARD) {
  if (metaCache) return metaCache;
  const r = await fetch(`${BASE}/api/card/${CARD}`, { headers: { 'x-api-key': KEY } });
  if (!r.ok) throw new Error('card meta ' + r.status);
  const j = await r.json();
  metaCache = {};
  (j.parameters || []).forEach(p => { if (p.slug) metaCache[p.slug] = p; });
  return metaCache;
}
async function queryMetabase(BASE, KEY, CARD, filters) {
  const defs = await metabaseParams(BASE, KEY, CARD);
  const parameters = [];
  for (const [slug, value] of Object.entries(filters)) {
    if (value === '' || value == null) continue;
    const p = defs[slug];
    if (!p) continue;
    parameters.push({ id: p.id, type: p.type, target: p.target, value });
  }
  const r = await fetch(`${BASE}/api/card/${CARD}/query/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ parameters })
  });
  if (!r.ok) throw new Error('metabase query ' + r.status);
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

// ---- Card Hedger: comparable sales by cert (also yields a card fallback) ----
// POST /v1/cards/comps-by-cert  { cert_number, grading_company, limit }  (X-API-Key)
async function cardHedgeComps(cert, grader, grade, KEY) {
  const BASE = (process.env.CARDHEDGE_URL || 'https://api.cardhedger.com').replace(/\/+$/, '');
  if (!KEY) return null;
  const body = { cert_number: cert, grading_company: grader, limit: 25, offset: 0 };
  if (grade) body.grade = String(grade);        // lock sales to the exact grade (e.g. PSA 10)
  const r = await fetch(`${BASE}/v1/cards/comps-by-cert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    body: JSON.stringify(body)
  });
  if (!r.ok) return null;                 // 404 = cert not in GemRate, etc.
  return await r.json();
}

// Card Hedger Fair Market Value by cert (our-system "estimate value").
// POST /v1/cards/fmv-by-cert  { cert, grader }  (X-API-Key)
async function cardHedgeFmv(cert, grader, KEY) {
  const BASE = (process.env.CARDHEDGE_URL || 'https://api.cardhedger.com').replace(/\/+$/, '');
  if (!KEY) return null;
  const r = await fetch(`${BASE}/v1/cards/fmv-by-cert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
    body: JSON.stringify({ cert, grader })
  });
  if (!r.ok) return null;
  return await r.json();
}

function salesFromComps(data) {
  if (!data) return null;
  const raw = Array.isArray(data.sales) ? data.sales : [];
  const recent = raw.map(s => ({
    date:   norm4(pick(s, 'saledate', 'date')),
    price:  numify(pick(s, 'price', 'amount')),
    grade:  String(pick(s, 'grade') || ''),
    source: String(pick(s, 'pricesource', 'source', 'marketplace') || ''),
    type:   String(pick(s, 'saletype', 'type') || ''),
    url:    String(pick(s, 'saleurl', 'url') || '')
  })).filter(s => s.price !== '' || s.date);
  const summary = {
    comp:  numify(data.comp_price != null ? data.comp_price : pick(data, 'compprice')),
    high:  numify(data.high),
    low:   numify(data.low),
    count: numify(data.total_count != null ? data.total_count : pick(data, 'totalcount', 'countused')),
    last:  recent.length ? recent.map(r => r.price).find(p => p !== '') ?? '' : ''
  };
  const hasSummary = ['comp', 'high', 'low', 'count', 'last'].some(k => summary[k] !== '');
  if (!recent.length && !hasSummary) return null;
  return { summary: hasSummary ? summary : null, recent };
}

// Build a fallback card from Card Hedger's comps-by-cert card + cert_info.
function cardFromComps(data, cert) {
  const c = data && data.card;
  const ci = (data && data.cert_info) || {};
  if (!c && !ci.grade) return null;
  const merged = Object.assign({}, c || {}, {
    cert: pick(ci, 'cert') || cert,
    grade: pick(ci, 'grade'),          // already a full label like "PSA 10"
    gradingcompany: ''                 // keep blank so grade_display == grade
  });
  return normalizeCard(merged, cert);
}

function graderFrom(card, fallback) {
  const g = String((card && (card.grade_display || card.grading_company)) || '').toUpperCase();
  const m = g.match(/PSA|BGS|SGC|CGC|CSG|HGA/);
  return m ? m[0] : fallback;
}

export default async function handler(req, res) {
  const BASE = (process.env.METABASE_URL || 'https://arena-club.metabaseapp.com').replace(/\/+$/, '');
  const CARD = process.env.CARD_MATCH_CARD_ID || '30460';
  const KEY  = process.env.METABASE_API_KEY;
  const defaultGrader = (process.env.CARDHEDGE_DEFAULT_GRADER || 'PSA').toUpperCase();
  const chKey = (req.headers && req.headers['x-ch-key']) || (req.query && req.query.chkey) || process.env.CARDHEDGE_API_KEY;

  const q = req.query || {};
  const cert = String(q.cert_number || q.cert || '').replace(/\D/g, '');
  const ac = String(q.ac_number || q.ac || '').trim();
  const reqGrader = String(q.grader || '').toUpperCase();
  if (!cert && !ac) { res.status(400).json({ error: 'cert_number or ac_number is required' }); return; }
  if (!KEY)  { res.status(500).json({ error: 'METABASE_API_KEY is not set' }); return; }

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');

  // 1) Metabase card (authoritative). Look up by cert or by 8AC number.
  let card = null, source = 'none';
  try {
    const filters = cert ? { cert_number: cert } : { ac_number: ac };
    const rows = await queryMetabase(BASE, KEY, CARD, filters);
    if (rows.length) { card = normalizeCard(rows[0], cert); source = 'metabase'; }
  } catch (e) {}

  // Cert to use for Card Hedger: the typed cert, or the one on the matched record.
  const certForCH = cert || (card && String(card.cert || '').replace(/\D/g, '')) || '';

  // 2) Card Hedger comps (sales + fallback card). Grader: explicit → from MB card → default.
  const grader = reqGrader || graderFrom(card, defaultGrader);
  const gradeLabel = card && card.grade ? String(card.grade) : '';   // lock CH sales to the Metabase grade
  let sales = null;
  if (certForCH) {
    try {
      const comps = await cardHedgeComps(certForCH, grader, gradeLabel, chKey);
      if (comps) {
        sales = salesFromComps(comps);
        if (!card) { const chCard = cardFromComps(comps, certForCH); if (chCard) { card = chCard; source = 'cardhedge'; } }
        // Prefer our own slab image; only borrow Card Hedger's if we don't have one.
        if (card && !card.image && comps.card && comps.card.image) card.image = comps.card.image;
      }
    } catch (e) {}
  }

  // 3) Estimated value: prefer Metabase's own value; else Card Hedger FMV; else comp price.
  let estimate = null;
  const mbVal = card ? numify(card.estimate_value) : '';
  if (mbVal !== '') {
    estimate = { value: mbVal, low: '', high: '', confidence: '', method: 'metabase' };
  }
  if (!estimate && certForCH) {
    try {
      const f = await cardHedgeFmv(certForCH, grader, chKey);
      const fmv = f && f.fmv;
      if (fmv && fmv.price != null) {
        estimate = {
          value: numify(fmv.price),
          low: numify(fmv.price_low),
          high: numify(fmv.price_high),
          confidence: String(fmv.confidence_grade || ''),
          method: 'fmv'
        };
      }
    } catch (e) {}
  }
  if (!estimate && sales && sales.summary && sales.summary.comp !== '') {
    estimate = { value: sales.summary.comp, low: sales.summary.low, high: sales.summary.high, confidence: '', method: 'comp' };
  }
  if (card) card.estimate = estimate;

  if (card) { card.sales = sales; res.status(200).json({ source, card }); return; }
  res.status(200).json({ source: 'none' });
}
