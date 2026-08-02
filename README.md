# Set IDs + Card Match → Vercel

A single-page app with two tabs:

- **Sets** — a browsable/searchable Set ID registry synced live from Metabase question **21088 ("set-ids")**.
- **Card Match** — look up a graded card by **cert** (type, scan, or OCR a label image) against Metabase question **30460 ("card-match")**, with **Card Hedger** comparable sales shown to the right and Card Hedger as a card-details fallback.

```
vercel-setids/
├─ index.html          the app
├─ api/
│  ├─ set-ids.js       proxy → Metabase 21088 (Sets tab)
│  └─ card-match.js    proxy → Metabase 30460 + Card Hedger (Card Match tab)
├─ package.json
├─ vercel.json
└─ README.md
```

## Why proxies?
Browsers can't call the authenticated Metabase or Card Hedger APIs directly — CORS blocks it
and the keys must never ship in a public file. The `/api/*` functions run on Vercel's server,
hold the keys in environment variables, call the upstreams, and return clean JSON on the same
origin. If a proxy is unreachable, the app degrades gracefully (Sets shows seed data; Card
Match shows "offline / no sales").

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Variable | Required | Default | Used by |
|---|---|---|---|
| `METABASE_API_KEY` | ✅ yes | — | both proxies |
| `METABASE_URL` | optional | `https://arena-club.metabaseapp.com` | both |
| `METABASE_CARD_ID` | optional | `21088` | Sets |
| `CARD_MATCH_CARD_ID` | optional | `30460` | Card Match |
| `CARDHEDGE_URL` | optional | `https://api.cardhedger.com` | Card Match sales/fallback |
| `CARDHEDGE_API_KEY` | optional | — | Card Match sales/fallback |
| `CARDHEDGE_DEFAULT_GRADER` | optional | `PSA` | Card Match |

Card Match works off Metabase alone if the `CARDHEDGE_*` vars are unset (just no sales panel).

## Deploy

### Option A — Vercel dashboard (no CLI)
1. Push this folder to GitHub (or drag-drop it into the Vercel dashboard).
2. **New Project → Import**. Framework preset: **Other** (no build step).
3. Add the environment variables above.
4. **Deploy.**

### Option B — Vercel CLI
```bash
npm i -g vercel
cd vercel-setids
vercel
vercel env add METABASE_API_KEY
vercel env add CARDHEDGE_API_KEY
vercel --prod
```

## Verify
- Sets tab: status pill reads **● Metabase live**; `/api/set-ids` returns a JSON array.
- Card Match tab: type a cert + pick the grader → the card renders, with a **Recent sales** panel on the right. Try `/api/card-match?cert_number=50000000&grader=PSA` directly to see the JSON.

## Card Hedger integration (confirmed from openapi.json)
- Base URL: `https://api.cardhedger.com`  ·  Auth header: **`X-API-Key`** (not Bearer).
- Sales endpoint: `POST /v1/cards/comps-by-cert` — body `{cert_number, grading_company, limit}`.
  Returns a comp summary (`comp_price`, `high`, `low`, `total_count`) plus a `sales` array
  (`sale_date`, `price`, `price_source`, `sale_type`, `sale_url`). The panel shows Comp / Last /
  # sales chips, a High·Low line, and the recent-sales list (price links to the sale).
- Card details come from **Metabase 30460** first; Card Hedger's `card` + `cert_info` are the
  fallback when a cert isn't in Metabase.
- The grader is required by Card Hedger, so the UI has a grader dropdown (defaults to PSA); when
  Metabase supplies the grade, the grader is inferred automatically.
- Alternative: `POST /v1/cards/prices-by-cert` returns daily **price history** instead of raw
  comps — swap the endpoint in `cardHedgeComps()` if you'd rather show a price trend.

## Card panel fields
The Card Match panel renders fields **dynamically per category**: core rows (Category, Cert,
Grade, Set Name, Set ID) always show; category-specific rows (Language, Subset, Insert, Insert
ID, Extra, Player, Card No., Rookie, Variant, Full Art, Rarity, Edition, Parallel, Parallel
Total) appear when the source provides them — matching the Baseball / Pokemon / One Piece layouts.
Field mapping lives in `normalizeCard()` in `api/card-match.js`; add key aliases there if a
field ever shows blank.

## OCR
"Drop a graded-label image" reads the cert with Tesseract.js (cdnjs) and auto-matches. Use a
tight crop of the label for best results; typing/scanning the cert always works.

## Notes
- Sets filtering (sport/brand/year/search) happens client-side; the proxy fetches all rows and
  Vercel edge-caches for ~60s. Card Match caches per cert for ~30s.
- To extend the Year picker beyond 2026, bump `YEAR_MAX` near the top of the `<script>` in `index.html`.
