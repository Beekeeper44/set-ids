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

## Sibling copies come free with the lookup
A cert lookup against 30460 returns the matched row **plus every other copy of the same card** —
rows sharing a `subset_id` (which identifies the card; `card_id` identifies the physical copy).
Each carries its own cert, grade, grading company, image and estimated value.

`/api/card-match` returns those as `siblings`, so the panel fills a missing est. value or image
without spending another query. `pickSibling()` chooses:

1. **Same grading company + same grade** → tier 2, preferring a copy that actually carries a value
   over an empty twin.
2. Otherwise **same grading company first, then closest grade** → tier 3. Staying inside one
   grading scale beats hopping to another, and closest-grade stops a PSA 9 inheriting the dearest
   PSA 10 in the vault.

`resolveFromSystem()` (separate identity queries) is now only the fallback for when the cert isn't
in 30460 at all and there are no siblings to work with.

## How a card is resolved
Lookups walk a cascade and stop at the first tier that answers. `card.match_tier` records which
one was used.

| Tier | Source | What it supplies |
|---|---|---|
| 1 | **Direct cert match** in Metabase 30460 | Everything — image, grade, grading company, est. value. Wins outright; lower tiers only fill gaps it left blank. |
| 2 | **Same card, same grading company + same grade** (a different cert) | Everything, including grade, company and est. value — it's the same slab class, so the value transfers. |
| 3 | **Next copy in the database**, any grade | Identity fields and est. value. **Never** grade, grading company, or the slab photo — a slab photo has the other card's cert and grade printed on the label. |
| 4 | **Card Hedger** | Anything still blank, plus comps. |

The **Cert** row always shows the cert you searched, never a sibling's. 8AC and the admin **Link**
are cleared whenever the panel isn't backed by a direct cert match, since they'd point at a
different physical item. The Est. Value box notes its origin — "same
grade, other cert" for tier 2, "other copy" for tier 3 — so a borrowed value is never mistaken
for this cert's own.

A record can match on cert (tier 1) and still be a **stub** — Arena Club, grade 0, every other
column empty, which is what a received-but-not-yet-catalogued card looks like. Those still walk
the cascade: the identity comes from Card Hedger, and the sibling supplies set name, Set ID,
parallel, image and est. value while the stub keeps its own cert, 8AC and admin link.

Tier 2 needs a real grade to search on, and a stub hasn't got one. It uses the grade and company
Card Hedger read off the actual cert instead — searching on the "Arena Club / 0" placeholder just
finds other ungraded stubs.

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

## The saved question returns unfiltered rows (important)
Question 30460 does **not** reliably apply its cert filter. A lookup for a single cert comes back
with ~40 rows: the real match plus a long tail of rows with a null `cert_number`, mostly empty but
some carrying `grading_company: arena_club`, tags like `confirmed_fake`, and a
`front_slab_picture_url`.

The proxy used to pick the row with the most non-empty columns, on the assumption every row
matched. It didn't: the genuine match often has only four populated columns, so a junk row won —
which is how another card's 8AC and slab scan appeared on unrelated certs (8AC 1884541 turning up
as both a Tom Brady and a Kobe Bryant, both showing a Babe Ruth "Supreme Cuts" scan).

`rowMatchesFilters()` now verifies every filter against the row before the tie-break, and rows
that don't match are discarded. Comparison is deliberately tolerant of formatting so it can't
over-filter: the `8AC` prefix is stripped (its "8" is a digit), leading zeros are ignored (they
vanish if the column is numeric), grades compare numerically (9 = 9.0), and text compares
case- and punctuation-insensitively (`arena_club` = `Arena Club`). If a filter's column isn't
present in the row at all, that filter is skipped rather than treated as a mismatch.

`?debug=1` reports `row_count`, `matched_count` and `discarded`. A large `discarded` on every
lookup confirms the filter isn't being applied server-side — worth fixing in the question, since
every consumer of 30460 has the same problem and only this proxy is now defending against it.

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

**Our scan has to earn it.** `ownImageTrusted()` keeps our picture only when the record can vouch
for this cert. It's dropped in favour of Card Hedger's when:

- the record's grade or grading company disagrees with what Card Hedger read off the cert — the
  row is describing a different slab (grader spelling differences like Beckett/BGS don't count as
  a disagreement); or
- the record is a stub with no real grade and no player or card number of its own, so nothing
  corroborates the scan.

This matters because `fillBlanks()` only fills *blanks* — a wrong-but-present image would never be
replaced otherwise. It's what put a Babe Ruth "Supreme Cuts" scan on a Kobe Bryant record whose
8AC (1884541) carried a mis-assigned picture. The scan is only dropped when Card Hedger actually
has one to put in its place, so a trustworthy-but-unverifiable picture is never traded for nothing.

Card Hedger's image was previously missed because `card-sales.js` only looked for a key named
exactly `image`, while the Metabase side checked ten spellings. `pickImage()` now checks the
known spellings, digs into nested containers (`images: {front: …}`) and arrays, and as a last
resort takes any image-ish key holding a URL. Values that aren't URLs are ignored, so a literal
"none" doesn't become a broken `<img>`.

If comps come back without a picture, one extra call to `details-by-certs` tries again — only
when the panel would otherwise show the "no image" placeholder.

Still no image? Hit `/api/card-sales?cert_number=…&grader=PSA&debug=1` — the `debug` block lists
the exact keys Card Hedger returned, so a new spelling can be added to `IMAGE_KEYS`.

### Card Hedger's null fields
Card Hedger routinely returns `player`, `set` and `category` as **null** while spelling the same
facts out in the descriptions:

```
card.description       "Garrett Wilson 2022 Panini Prizm Football"
cert_info.description  "2022 Panini Prizm Garrett Wilson Autograph 309"
```

`splitDescription()` recovers them from `card.description` by splitting at the year — what
precedes it is the player, the rest is the set, and a trailing sport word gives the category.
The `cert_info` style interleaves player and set, so nothing is taken from it rather than
guessing wrong. This matters beyond display: the recovered set name feeds `lookupSetId()`
("2022 Panini Prizm Football" → `FB PP 2022`), and the recovered player makes the tier 2/3
sibling search far more precise than a card number alone.

### Wrong image?
Hover the picture: the tooltip names its source ("Image from Arena Club record" / "another copy
in our database" / "Card Hedger"). That distinguishes an app bug from bad source data.

If it says **Arena Club record**, the URL is coming out of Metabase 30460 and the app is
displaying it faithfully — the scan itself is mis-assigned. Confirm with:

```
/api/card-match?cert_number=<cert>&debug=1
```

`debug.raw_row` shows the exact `front_slab_picture_url` stored against that 8AC. If two adjacent
8ACs carry the same URL, a scanning batch mapped images to the wrong records and it needs fixing
at the source — every tool reading that column shows the same wrong picture.

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
