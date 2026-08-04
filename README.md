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
Row order and behaviour (unchanged from the original layout, except Subset now sits directly
under Category):

Category, **Subset**, Language, Cert, 8AC, Grade, Set Name, Set ID, Insert, Insert ID, Extra,
Player, Card No., Rookie, Variant, Finish, Full Art, Rarity, Edition, Parallel, Parallel Total, Tag.

Rows flagged `core:1` in `FIELD_DEFS` always render, showing "—" when blank: Category, Cert,
Grade, Set Name, Set ID, Insert, Insert ID, Variant, Finish, Full Art, Rarity, Edition, Parallel.
Everything else appears only when the source has a value, which is why Language / Extra /
Parallel Total / Tag come and go per card and Subset shows on a Pokemon card but not on a bare
Donruss base. Rookie renders only when the source actually has a rookie column.

To change what stays visible, add or remove `{core:1}` on a row in `FIELD_DEFS`. To move a row,
move its line — the array order is the render order.

Field mapping lives in `normalizeCard()` in `api/card-match.js`; add key aliases there if a
field ever shows blank.

## How a card is resolved
Lookups walk a cascade and stop at the first tier that answers. `card.match_tier` records which
one was used.

| Tier | Source | What it supplies |
|---|---|---|
| 1 | **Direct cert match** in Metabase 30460 | Everything — image, grade, grading company, est. value. Wins outright; lower tiers only fill gaps it left blank. |
| 2 | **Same card, same grading company + same grade** (a different cert) | Everything, including grade, company and est. value — it's the same slab class, so the value transfers. |
| 3 | **Next copy in the database**, any grade | Identity fields, image and est. value. **Never** grade or grading company — those belong to the other slab. |
| 4 | **Card Hedger** | Anything still blank, plus comps. |

8AC and the admin **Link** are cleared whenever the panel isn't backed by a direct cert match,
since they'd point at a different physical item. The Est. Value box notes its origin — "same
grade, other cert" for tier 2, "other copy" for tier 3 — so a borrowed value is never mistaken
for this cert's own.

Tier 2 and 3 run against `/api/card-match` using its identity parameters (`player_name`,
`card_no`, `set_name`, `insert_name`, `parallel_name`, plus `grading_company` and `grade` for
tier 2), narrowest query first, then a looser player + card number query.

## Set ID resolution
Metabase 30460 often returns a blank `set_id`. When it does, `lookupSetId()` matches the card's
set name against the Sets registry (question 21088) and derives the ID the same way the Sets tab
does — `sid()` / `idFor()`, i.e. sport code + set code + year. Matching rules: years are stripped before comparing; the registry set name must be fully
contained in the card's set name; ranking favours distinctive tokens, so `Panini Mosaic` (`FB PM`)
beats a generic `Panini Football` (`FB PF`). Brand and language act as tiebreakers rather than
filters — that's what lets Japanese Pokemon cards resolve to the `… JPN` codes. Round-tripping the
whole registry resolves ~99% of sets exactly; the rest are entries the registry stores twice under
different codes with the same words (e.g. `Topps Holiday Bowman` vs `Bowman Topps Holiday`,
`Skybox E X-2000` vs `SkyBox E-X2000`), which can't be told apart from a set name alone.

## Cert collisions across graders (important)
Cert numbers are only unique *within* a grading company — PSA 92229842 and Arena Club 92229842
are unrelated cards. The app used to send the cert with whatever the grader dropdown said
(default PSA), so an Arena Club record could come back with a stranger's slab image, comps, and
"Most Recent Sale" attached to it. Three guards now prevent that:

1. **The record picks the grader.** `chGraderFor()` uses the Metabase record's `grading_company`;
   the dropdown is only a fallback for a bare cert with no record behind it. Company names are
   mapped through `CH_GRADER_ALIASES`, so a record that says "Beckett" still queries as BGS. If
   Metabase starts emitting another spelling, add it there or that grader silently loses comps.
2. **Non-Card-Hedger graders are only queried when there's no real grade.** An Arena Club record
   carrying an actual grade owns its cert namespace, so no lookup happens. But "Arena Club 0"
   means *not yet graded* — the slab may be a third-party one — so the selected grader is tried
   and Card Hedger's grade + grading company replace the placeholder outright. Guard 3 is what
   keeps that safe.
3. **Identity is verified.** `sameCard()` compares card number, player, and set year; if Card
   Hedger's record disagrees, its card and sales are discarded and the panel notes the collision.

Consequence worth knowing: an Arena Club / ungraded record legitimately shows **No Comps**. There
is no cert to price against until the card has a third-party cert. If you want comps for those,
the endpoint needed is an identity search (player + set + card no + grade) rather than
`comps-by-cert` — Card Hedger's cert endpoints can't do it.

## Card images
Order of preference: our own record's picture (`front_slab_picture_url` and friends), then a
sibling copy via the resolution cascade, then Card Hedger.

Card Hedger's image was previously missed because `card-sales.js` only looked for a key named
exactly `image`, while the Metabase side checked ten spellings. `pickImage()` now checks the
known spellings, digs into nested containers (`images: {front: …}`) and arrays, and as a last
resort takes any image-ish key holding a URL. Values that aren't URLs are ignored, so a literal
"none" doesn't become a broken `<img>`.

If comps come back without a picture, one extra call to `details-by-certs` tries again — only
when the panel would otherwise show the "no image" placeholder.

Still no image? Hit `/api/card-sales?cert_number=…&grader=PSA&debug=1` — the `debug` block lists
the exact keys Card Hedger returned, so a new spelling can be added to `IMAGE_KEYS`.

## Other panel behaviour
- Values are shown exactly as the source supplies them. `polishCard()` only fills blanks — a
  missing Set ID, and a missing Parallel — and never rewrites a value Metabase returned.
- **Parallel** is mirrored from the Variant column when Variant names a colour/pattern parallel
  ("Camo Red", "Press Proof Premium", "Silver Prizm"). Card-type words are left alone, so "Base",
  "Full Art", "Rated Rookie" and "Short Print" never become parallels. The vocabulary is two
  editable arrays, `PARALLEL_WORDS` and `NOT_PARALLEL`; add to them when a parallel line is
  missed or a non-parallel slips through. Variant keeps its value, so a mirrored card shows the
  same text in both rows.
- **Broken image URLs** fall back to the "no image" placeholder instead of the browser's broken-image
  icon (`imgFail()`).

## OCR
"Drop a graded-label image" reads the cert with Tesseract.js (cdnjs) and auto-matches. Use a
tight crop of the label for best results; typing/scanning the cert always works.

## Notes
- Sets filtering (sport/brand/year/search) happens client-side; the proxy fetches all rows and
  Vercel edge-caches for ~60s. Card Match caches per cert for ~30s.
- To extend the Year picker beyond 2026, bump `YEAR_MAX` near the top of the `<script>` in `index.html`.
