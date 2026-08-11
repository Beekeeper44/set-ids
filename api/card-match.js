// api/card-match.js — Vercel serverless function (FAST path)
// Returns just the Metabase card (question 30460) so the UI can render immediately.
// Card Hedger sales/FMV are fetched separately by /api/card-sales.
//
// Env: METABASE_API_KEY (required), METABASE_URL (optional), CARD_MATCH_CARD_ID (optional, 30460)

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Bumped whenever this file changes. Returned on every response so the page can tell you when the
// API is older than itself — several fixes here are server-side only, and a static refresh leaves
// them behind silently.
const BUILD = '2026-08-11-batch-8ac';
const pick = (o, ...targets) => {
  if (!o) return '';
  const keys = Object.keys(o);
  for (const t of targets) { const k = keys.find(k => norm(k) === t); if (k !== undefined && o[k] != null) return o[k]; }
  return '';
};
const hasKey = (o, ...targets) => !!o && Object.keys(o).some(k => targets.includes(norm(k)));
const asBool = v => { if (typeof v === 'boolean') return v; const s = norm(v); return s==='true'||s==='t'||s==='y'||s==='yes'||s==='1'||s==='rookie'; };
const numify = v => { if (v===''||v==null) return ''; const n=Number(String(v).replace(/[^0-9.\-]/g,'')); return isNaN(n)?'':n; };
// $0.00 means "not valued yet", not "worth nothing" — no card in the vault is genuinely worth
// zero. Treating it as a real number would show "$0" and, worse, let a zero-valued copy be
// suggested to its twins as though it were a price.
const priced = v => { const n = numify(v); return (n === '' || !(Number(n) > 0)) ? '' : n; };
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
    status: pick(o,'status','cardstatus')||'',
    language: pick(o,'language','lang')||'',
    cert: String(pick(o,'certnumber','cert','certno')||certFallback||''),
    grade: grade||'',
    grading_company: company||'',
    grade_display: gradeDisplay(company?graderName(company):'', grade),
    set_name: pick(o,'setname','set')||'',
    set_id: pick(o,'setid')||'',
    subset_id: pick(o,'subsetid')||'',
    subset: pick(o,'subsetname','subset','settype')||'',
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
    // When the estimated value was last set. ONLY explicit est-value timestamps — never
    // updated_at (any row edit bumps it) or fmv_updated_at (dates FMV, a different number).
    // estimated_value_on first (the date the value was set), estimated_value_at as fallback.
    // Never updated_at (any row edit bumps it) or fmv_updated_at (dates FMV, a different number).
    estimate_date: pick(o,'estimatedvalueon','estimatedvalueat','estimatedvalueupdatedat',
      'estvalueon','estvaluedate','estimatedvaluedate','valuedon','valuedat','recompedat')||'',
    image: pick(o,'frontslabpictureurl','slabpictureurl','frontpictureurl','pictureurl','imageurl','image','cardimage','frontimage','imagefront','img')||''
  };
}

// The saved question returns rows with a null cert alongside the real match, so the filter can't
// be assumed to have held. Verify each filter against the row before trusting it — otherwise the
// "most-populated row" tie-break below happily picks an unrelated row that has more columns filled.
const FILTER_COLS = {
  cert_number:     ['certnumber','cert','certno'],
  ac_number:       ['acnumber','ac','8ac'],
  player_name:     ['playername','player','character','subject'],
  card_no:         ['cardno','cardnumber','number'],
  grade:           ['grade'],
  grading_company: ['gradingcompany','grader','gradecompany','company'],
  set_name:        ['setname','set'],
  insert_name:     ['insertname','insert'],
  subset_name:     ['subsetname','subset'],
  parallel_name:   ['parallelname','parallel']
};
// Identifier comparison has to survive formatting differences: the "8AC" prefix (whose 8 is a
// digit), and leading zeros that vanish if Metabase stores the column as a number.
const idKey = v => String(v == null ? '' : v).replace(/^\s*8ac/i, '').replace(/\D/g, '').replace(/^0+/, '');
const hasCol = (o, cols) => Object.keys(o || {}).some(k => cols.indexOf(norm(k)) >= 0);
function rowMatchesFilters(row, filters) {
  for (const slug of Object.keys(filters || {})) {
    const cols = FILTER_COLS[slug];
    if (!cols || !hasCol(row, cols)) continue;   // can't verify this one — don't reject on it
    const got = pick(row, ...cols);
    const want = filters[slug];
    if (slug === 'cert_number' || slug === 'ac_number') {
      if (idKey(got) === '' || idKey(got) !== idKey(want)) return false;
    } else if (slug === 'grade') {
      const a = parseFloat(String(got).replace(/[^0-9.]/g, ''));
      const b = parseFloat(String(want).replace(/[^0-9.]/g, ''));
      if (!(isFinite(a) && isFinite(b) && a === b)) return false;
    } else {
      if (norm(got) === '' || norm(got) !== norm(want)) return false;
    }
  }
  return true;
}


// Rows sharing a subset_id are copies of the same card — each with its own cert, grade and
// est. value. card_id identifies the physical copy; subset_id identifies the card itself.
// So the response to a cert lookup already carries every sibling copy; no extra query needed.
// Rows sharing a subset_id are copies of the same card. A *matching* subset_id is proof; a
// mismatch is not a veto — copies of one card can carry different subset_ids in 30460, and
// treating that as authoritative hid an Arena Club 9.5 twin holding the only relevant value.
// So: equal subset_id confirms, otherwise fall through to comparing the identity fields.
function sameSku(a, b) {
  const sa = norm(pick(a, 'subsetid')), sb = norm(pick(b, 'subsetid'));
  if (sa && sb && sa === sb) return true;
  const key = r => [
    norm(pick(r, 'playername', 'player')),
    norm(pick(r, 'cardno', 'cardnumber', 'number')),
    norm(pick(r, 'setname', 'set')),
    norm(pick(r, 'insert', 'insertname')),
    norm(pick(r, 'parallelname', 'parallel'))
  ].join('|');
  const ka = key(a);
  // Require real identity, not two mostly-blank rows agreeing on nothing.
  return ka === key(b) && ka.replace(/\|/g, '').length > 2;
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
  // ?player_sport=<name> → which sport this player's cards are tagged with, and how dominant it
  // is. Individual rows are mis-tagged often enough that the caller needs the share, not a single
  // row's sport: Ohtani carries a few basketball rows against ~38k baseball ones.
  if (q.player_sport != null && String(q.player_sport).trim() !== '') {
    const name = String(q.player_sport).trim();
    try {
      const rows = await queryMetabase(BASE, KEY, CARD, { player_name: name });
      const keep = rows.filter(r => rowMatchesFilters(r, { player_name: name }));
      const tally = {};
      keep.forEach(r => { const sp = norm(pick(r, 'sport', 'category')); if (sp) tally[sp] = (tally[sp] || 0) + 1; });
      const total = Object.values(tally).reduce((a, b) => a + b, 0);
      const best = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] || '';
      res.status(200).json({
        sport: best,
        share: total ? tally[best] / total : 0,
        total,
        tally
      });
    } catch (e) { res.status(200).json({ sport: '', share: 0, total: 0, tally: {} }); }
    return;
  }

  const IDK = ['player_name', 'card_no', 'grade', 'grading_company', 'set_name', 'insert_name', 'subset_name', 'parallel_name'];
  const idFilters = {};
  IDK.forEach(k => { if (q[k] != null && String(q[k]).trim() !== '') idFilters[k] = String(q[k]).trim(); });

  let filters = null;
  if (cert) filters = { cert_number: cert };
  else if (ac) filters = { ac_number: ac };
  else if (Object.keys(idFilters).length) filters = idFilters;
  if (!filters) { res.status(400).json({ error: 'cert_number, ac_number, or identity params required' }); return; }
  if (!KEY) { res.status(500).json({ error: 'METABASE_API_KEY is not set' }); return; }

  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
  const nonEmpty = r => Object.values(r || {}).filter(v => v != null && String(v).trim() !== '').length;
  try {
    const rows = await queryMetabase(BASE, KEY, CARD, filters);
    // Keep only rows the filter genuinely matched. Without this, a cert lookup that returns
    // 40 null-cert rows lets an unrelated row win the most-populated tie-break below — which
    // is how another card's 8AC and slab scan end up on screen.
    const matched = rows.filter(r => rowMatchesFilters(r, filters));
    if (matched.length) {
      // When a cert/8AC matches several rows (e.g. component + main), use the most-populated one.
      const row = matched.length > 1 ? matched.slice().sort((a, b) => nonEmpty(b) - nonEmpty(a))[0] : matched[0];
      const card = normalizeCard(row, cert);
      const mbVal = priced(card.estimate_value);
      if (mbVal === '') card.estimate_value = '';
      card.estimate = mbVal !== '' ? { value: mbVal, low: '', high: '', confidence: '', method: 'metabase' } : null;

      // Other copies of the same card, already in this response — the est. value and image the
      // matched row is missing usually live here.
      const siblings = rows
        .filter(r => r !== row && sameSku(row, r))
        .map(r => {
          const s = normalizeCard(r, '');
          const v = priced(s.estimate_value);
          if (v === '') s.estimate_value = '';
          s.estimate = v !== '' ? { value: v, low: '', high: '', confidence: '', method: 'metabase' } : null;
          return s;
        });

      const out = { build: BUILD, source: 'metabase', card, siblings };
      if (q.debug) {
        // Every 8AC the question returned, so you can see at a glance whether a copy you expect
        // is absent from the response (a 30460 problem) or present but grouped out (ours).
        const acs = rows.map(r => String(pick(r, 'acnumber', 'ac', '8ac') || '')).filter(Boolean);
        const sibAcs = siblings.map(x => String(x.ac_number || '')).filter(Boolean);
        out.debug = {
          row_count: rows.length,
          matched_count: matched.length,
          discarded: rows.length - matched.length,
          sibling_count: siblings.length,
          returned_ac_numbers: acs.slice(0, 400),
          sibling_ac_numbers: sibAcs.slice(0, 400),
          grouped_out: acs.filter(a => a !== String(card.ac_number) && sibAcs.indexOf(a) < 0).slice(0, 100),
          chosen_nonempty: nonEmpty(row),
          raw_keys: Object.keys(row || {}),
          raw_row: row
        };
      }
      res.status(200).json(out);
      return;
    }
    if (q.debug) { res.status(200).json({ build: BUILD, source: 'none', debug: { row_count: rows.length, matched_count: 0, discarded: rows.length, filters, sample_row: rows[0] || null } }); return; }
  } catch (e) {
    if (q.debug) { res.status(200).json({ source: 'error', debug: { error: String(e).slice(0, 300) } }); return; }
  }
  res.status(200).json({ source: 'none' });
}
