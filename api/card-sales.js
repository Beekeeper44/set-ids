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

// Card Hedger doesn't guarantee a key named "image" — it may be image_url, front_image, a
// nested object, or a list. Check the known spellings, then any key that looks image-ish
// whose value is a URL, rather than silently returning no picture.
const IMAGE_KEYS = ['image','images','imageurl','imageurls','imageurlfront','frontimage','frontimageurl','imagefront',
  'cardimage','cardimageurl','frontslabpictureurl','slabpictureurl','slabimage','slabimageurl',
  'frontpictureurl','pictureurl','pictures','picture','photo','photos','photourl','img','imgurl','thumbnail','thumburl'];
const looksLikeUrl = v => typeof v === 'string' && /^(https?:)?\/\//i.test(v.trim());
function pickImage(o, depth) {
  if (!o || typeof o !== 'object') return '';
  const d = depth || 0;
  const keys = Object.keys(o);
  for (const t of IMAGE_KEYS) {
    const k = keys.find(k => norm(k) === t);
    if (k === undefined) continue;
    const v = o[k];
    if (looksLikeUrl(v)) return v.trim();
    if (Array.isArray(v)) {
      const hit = v.find(looksLikeUrl);
      if (hit) return hit.trim();
      if (d < 2) for (const el of v) { const n = pickImage(el, d + 1); if (n) return n; }
    } else if (v && typeof v === 'object' && d < 2) {
      const n = pickImage(v, d + 1); if (n) return n;
    }
  }
  // Anything image-ish left: a URL directly, or a container to dig into.
  for (const k of keys) {
    if (!/(image|photo|picture|img|thumb|scan)/.test(norm(k))) continue;
    const v = o[k];
    if (looksLikeUrl(v)) return String(v).trim();
    if (Array.isArray(v)) { const hit = v.find(looksLikeUrl); if (hit) return hit.trim(); }
    if (v && typeof v === 'object' && d < 2) { const n = pickImage(v, d + 1); if (n) return n; }
  }
  // Inside a container we already judged image-ish (images: {front: "..."}), any URL will do.
  if (d > 0) for (const k of keys) { if (looksLikeUrl(o[k])) return String(o[k]).trim(); }
  return '';
}
const gradeDisplay = (c, g) => [String(c||'').trim(), String(g??'').trim()].filter(Boolean).join(' ');
const GRADER_NAMES = { psa:'PSA', bgs:'BGS', sgc:'SGC', cgc:'CGC', csg:'CSG', hga:'HGA', arenaclub:'Arena Club' };
const graderName = c => { const k = norm(c); return GRADER_NAMES[k] || String(c || '').toUpperCase(); };

function normalizeCardFromComps(data, cert) {
  const c = data && data.card; const ci = (data && data.cert_info) || {};
  if (!c && !ci.grade) return null;
  const o = Object.assign({}, c || {});  const grader = ci.grader ? String(ci.grader) : '';
  const gradeLabel = ci.grade ? String(ci.grade) : '';
  const gradeNum = (gradeLabel.match(/[0-9.]+/) || [''])[0] || '';
  return {
    category: pick(o,'category')||'',
    ac_number: '', language: '',
    cert: String(ci.cert || cert || ''),
    grade: gradeNum,
    grading_company: grader ? graderName(grader) : '',
    grade_display: gradeLabel || (grader ? gradeDisplay(graderName(grader), gradeNum) : ''),
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
    image: pickImage(o) || pickImage(ci) || pickImage(data) || ''
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

function firstDetail(d){
  if(!d) return null;
  if(Array.isArray(d)) return d[0]||null;
  if(Array.isArray(d.results)) return d.results[0]||null;
  if(Array.isArray(d.data)) return d.data[0]||null;
  if(d.cert_info||d.card) return d;
  const vals=Object.values(d).filter(v=>v&&typeof v==='object');
  const hit=vals.find(v=>v.cert_info||v.card);
  return hit||null;
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
  // No comps (no recent sales) → still identify the card so we can fill fields.
  let detail = null;
  if (!comps) {
    try { detail = firstDetail(await chFetch('/v1/cards/details-by-certs', { certs: [cert], grader }, KEY, BASE)); } catch (e) {}
  }
  const src = comps || detail;

  const sales = comps ? salesFromComps(comps) : null;
  const card = src ? normalizeCardFromComps(src, cert) : null;   // always provide for enrichment

  // Comps answered but carried no picture — details-by-certs often has one. Only worth the
  // extra call when we'd otherwise show the "no image" placeholder.
  if (card && !card.image && comps) {
    try {
      const d2 = firstDetail(await chFetch('/v1/cards/details-by-certs', { certs: [cert], grader }, KEY, BASE));
      if (d2) {
        const img = pickImage(d2.card) || pickImage(d2.cert_info) || pickImage(d2);
        if (img) card.image = img;
      }
    } catch (e) {}
  }

  const chCard = src && src.card ? src.card : null;
  const ci = src && src.cert_info ? src.cert_info : null;
  const ch_variant = chCard ? String(chCard.variant || '') : '';
  const ch_desc = chCard ? String(chCard.description || '') : '';
  const ch_cert_desc = ci ? String(ci.description || '') : '';

  const out = { sales, estimate: null, card, ch_variant, ch_desc, ch_cert_desc };
  // ?debug=1 → see exactly what Card Hedger sent, so a missed image key can be added above.
  if (q.debug) {
    out.debug = {
      image_found: card ? card.image : '',
      card_keys: chCard ? Object.keys(chCard) : [],
      cert_info_keys: ci ? Object.keys(ci) : [],
      top_keys: src ? Object.keys(src) : []
    };
  }
  res.status(200).json(out);
}
