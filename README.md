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

## Status is carried through and shown
`status` comes back on every row and gets its own sortable column in the copies table. It matters
because 30460 filters on it — a copy outside the allowed statuses simply won't be in the response,
and without the column that looks like the copy doesn't exist. Blank statuses sort last in both
directions.

Question 30460's status list must include every status you want to see. `pending_release` was
missing, which is why 8AC 3902111 (the only Arena Club 9.5 carrying a value) was invisible from
every other copy of that card — the seed-card exemption meant it appeared when searched directly
and vanished otherwise.

## Speed
A lookup used to make up to **nine sequential round trips** — the cert match, Card Hedger, then
`settleIds` firing sport / Set ID / insert ID / subset ID one after another, then the value hunt.
At ~700ms each that's the 5–10s wait. Three changes:

- **`settleIds` runs its queries in parallel.** Set ID, insert ID and subset ID don't depend on
  each other, so they go out together: 4 sequential calls became 1 batch.
- **Sport is only resolved when it's needed.** It costs a query and exists solely to guard the
  *registry* Set ID lookup — if the Set ID is already known there's nothing to guard, so it's
  skipped. That's the common case.
- **Every `/api/card-match` query is cached and de-duplicated** for the life of the page
  (`mbFetch`), so repeats and concurrent identical calls share one round trip.
- **Card Hedger starts immediately** rather than after our Metabase work, so the slowest leg
  overlaps the rest instead of queueing behind it.

Simulated at 700ms per round trip, `settleIds` went from 2800ms to 701ms cold and 0ms warm.
Batch mode already runs a 4-worker pool and benefits from the shared cache.

## Sibling copies come free with the lookup
A cert lookup against 30460 returns the matched row **plus every other copy of the same card**.
`sameSku()` treats a **matching** `subset_id` as proof, but a **mismatch is not a veto** — copies of
one card do carry different `subset_id`s in 30460, so it falls through to comparing player, card
number, set name, insert and parallel. Treating a mismatch as authoritative hid an Arena Club 9.5
twin (8AC 3902111, $25) from its own copy, which then took a $15 suggestion off a CSG 9.5 instead.

That divergence is worth fixing upstream: two identical Wigglytuff Arena Club 9.5s should not sit
under different `subset_id`s, and anything else joining on that column has the same blind spot.
Each carries its own cert, grade, grading company, image and estimated value.

`/api/card-match` returns those as `siblings`, so the panel fills a missing est. value or image
without spending another query. `pickSibling()` chooses:

1. **Same grading company + same grade** → tier 2, preferring a copy that actually carries a value
   over an empty twin. Companies are compared through `canonCompany()`, because 30460 stores the
   column as free text — `beckett`, `Beckett Grading Services` and `BGS` are one grader and must
   match as siblings, while `arena_club` stays distinct from all of them. Grades parse as numbers,
   so BGS/SGC half grades (9.5, 8.5) and `9` vs `9.0` compare correctly.
2. Otherwise **same grading company first, then closest grade** → tier 3. Staying inside one
   grading scale beats hopping to another, and closest-grade stops a PSA 9 inheriting the dearest
   PSA 10 in the vault.

Sibling enrichment runs **before** the Card Hedger gate, using the record's own grading company
and grade. That ordering matters: an Arena Club card never reaches Card Hedger (no third-party
cert), so if enrichment sat inside that block it would render with only its own row — which is
why one 8AC showed a full card and its identical twin showed almost nothing.

The panel lists **Other copies in the vault** beneath the fields — copies that carry an est. value, **plus every copy graded by the
same company as the card being viewed** even when unvalued. For an Arena Club 9.5 the other Arena
Club copies are the most relevant comparison there is, and they're also the least likely to have
been valued — filtering purely on value made them vanish exactly when they mattered. Other
companies still need a value to appear. Chip counts reflect valued copies
only, so they'll read lower than the raw copy count. There are two filter rows: **grading company** (PSA, BGS, SGC, CGC, CSG, Arena Club) and, beneath
it, **company + grade**. Clicking a company chip ticks or clears every grade under it in one go,
and it renders half-lit when only some of its grades are selected. Company chips use the canonical
grader name, so one **BGS** chip covers rows spelled `beckett`, `BGS` and `bvg` rather than
labelling itself after whichever spelling happened to come first.

Below that is a checkbox per grading company + grade (`PSA 10`, `Arena Club 9.5`, `BGS 9.5`…). All are on by default, with **select all** / **deselect all**; deselecting
everything genuinely empties the table rather than reverting to all. Chips are keyed through `canonCompany()` and a numeric grade, so `Beckett 9.5`
and `BGS 9.5` collapse into one. Filtering affects the table only — the suggested value above is
unchanged.

The card being viewed is excluded from its own list: 30460 can return the same item twice
(component + main row), so one copy becomes the card and the other used to appear as a sibling
with no est. value. Matching is on `idKeyJS()`, so `8AC003117326` and `3117326` compare equal.

The list — 8AC, grade, cert and est. value
for every sibling, with the copy a borrowed value came from highlighted. The Est. Value caption
names it too ("Arena Club · same grade, from 8AC 3849393"), so a borrowed number is always
traceable to a real item.

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

**Grade and grading company are never sent as filters.** The column is free text — Card Hedger
says `PSA`, 30460 stores `psa` — and a casing mismatch in the server-side filter silently drops an
exact-grade match to a nearest-grade one, losing the grade and image with it. `resolveFromSystem()`
queries on identity alone, takes back every copy (`card` + `siblings`), and picks client-side via
`pickSibling()`, where `canonCompany()` and numeric grade comparison already handle the variations.

Tier 2 and 3 run against `/api/card-match` using its identity parameters (`player_name`,
`card_no`, `set_name`, `insert_name`, `parallel_name`, plus `grading_company` and `grade` for
tier 2), narrowest query first, then a looser player + card number query.

## Set ID resolution
Metabase 30460 often returns a blank `set_id`. When it does, `lookupSetId()` matches the card's
set name against the Sets registry (question 21088) and derives the ID the same way the Sets tab
does — `sid()` / `idFor()`, i.e. sport code + set code + year. Matching runs three passes, scored so the most literal wins:

| Pass | Matches when | Example |
|---|---|---|
| exact | every registry token appears in the card's set name | `Panini Mosaic` ⊂ `2025 Panini Mosaic Football` |
| relaxed | same, ignoring **one** trailing `Series` / `Set` / `Edition` | registry `Scarlet & Violet Series` ← card `2023 Pokemon Scarlet & Violet` |
| code | the card spells the set as its registry code | card `2023 Pokemon SWSH` → `PKMN SWSH 2023` |

Only one trailing descriptor is stripped, never a run — `Base Set Series` must reduce to `Base Set`,
not to `Base`, or the German `Base Set` outscores the English entry. For TCG the registry's brand
column holds the **language**; a card naming no language is treated as English, so a foreign
edition can't win on a literal name match.

Other rules: years are stripped before comparing; the registry set name must be fully
contained in the card's set name; ranking favours distinctive tokens, so `Panini Mosaic` (`FB PM`)
beats a generic `Panini Football` (`FB PF`). Brand and language act as tiebreakers rather than
filters — that's what lets Japanese Pokemon cards resolve to the `… JPN` codes. Round-tripping the
whole registry resolves ~99% of sets exactly; the rest are entries the registry stores twice under
different codes with the same words (e.g. `Topps Holiday Bowman` vs `Bowman Topps Holiday`,
`Skybox E X-2000` vs `SkyBox E-X2000`), which can't be told apart from a set name alone.

## Build stamp — check this before debugging anything
`api/card-match.js` carries a `BUILD` constant and returns it on every response. `index.html`
carries the matching `APP_BUILD`. When they diverge the panel shows an orange banner naming the
API's build and telling you to redeploy.

This exists because most of the fixes in this project are **server-side** — sibling matching,
`estimated_value_on`, the filter verification, the cert-collision guards — and a static refresh of
`index.html` leaves them behind with no visible symptom. Several rounds of debugging went into
"why isn't this working" when the answer was that `api/` hadn't been deployed.

**Bump `BUILD` and `APP_BUILD` together whenever `api/card-match.js` changes.**

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

`?debug=1` reports `row_count`, `matched_count`, `discarded`, `sibling_count`, plus
`returned_ac_numbers` (every 8AC the question sent), `sibling_ac_numbers` (what we grouped in) and
`grouped_out` (returned but not grouped). Those three answer the recurring question of whether a
missing copy is **absent from the response** — a 30460 problem — or **present and grouped out** —
ours. A large `discarded` on every
lookup confirms the filter isn't being applied server-side — worth fixing in the question, since
every consumer of 30460 has the same problem and only this proxy is now defending against it.

## Third-party graders (PSA / BGS / SGC / CGC / CSG / HGA)
These reach Card Hedger, so they get a tier Arena Club cards don't: comps, an image, and the real
grade when our row is a stub. Company spellings are canonicalised (`beckett`, `Beckett Grading
Services`, `bvg` → BGS), and half grades compare numerically, so BGS/SGC/CSG 9.5 and 8.5 match
their own twins as exact siblings.

**SGC's 10–100 scale.** SGC graded 10–100 for years — SGC 96 is roughly a 9 — and records still
carry both forms. `gradeScale()` classifies a grade as ten-point or hundred-point, and grades on
*different* scales are treated as "can't compare" rather than a contradiction. Without it, our
`SGC 96` row versus Card Hedger's `SGC 9` looked like a different card and its image was thrown
away. No conversion is assumed in either direction — if 30460 should be storing one canonical
scale, that's a data fix, not a matcher fix.

**Language editions.** Metabase writes the language into the set name ("2022 Pokemon **Japanese**
Dark Phantasma") and often leaves the language field empty, so `lookupSetId()` reads language words
out of the name as well. An edition whose brand contradicts the card's language is penalised: if a
language is known, anything else is wrong; if none is given, English is assumed. Without that, the
Chinese row literally named `Sword & Shield` beat the Japanese `Sword & Shield Series` on being a
more exact string.

**The Pokemon registry is series-level, not expansion-level.** It holds `Sword & Shield Series`,
`Scarlet & Violet Series`, `Black & White Series` — 49 rows. Expansions like Dark Phantasma, Lost
Abyss and Crown Zenith aren't in it, so a card named after its expansion can't map through the
registry at all. Those resolve via `lookupSetIdInSystem()` instead — catalogue one card and every
other copy follows.

**Known limit:** BGS Black Label 10 and a regular BGS 10 are indistinguishable here — both parse
as grade 10 and will match each other as exact siblings, despite very different values. If 30846
carries a subgrade or label-type column, that's what would separate them.

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

## Sport resolution
Both directions come out of `SPORTS` — no separate lookup table. Sport names are indexed through
`setTokens()` as well as `normSport()`, because a stopword inside a name ("Magic **The** Gathering")
otherwise can't match a phrase pulled from a set name. `sportFromSetName()` tries three-word, then
two-word, then one-word phrases so "One Piece" and "Dragon Ball S" resolve.

Order: Card Hedger's `category` → sport word in the set name → `sportFromPlayer()`. The last one
asks `/api/card-match?player_sport=<name>`, which returns the sport tally for that player.

**It takes the dominant sport, not a unique one.** Measured on ~51k players, 2.61% carry more than
one sport — but weighted by card volume that's most of the collection, because the mis-tagged
players are the most-collected ones (Ohtani has basketball rows against ~38k baseball). Requiring
uniqueness would decline exactly when it's needed. So the top sport wins when it holds ≥95%
(`SPORT_DOMINANCE`) of that player's cards, and anything less declines — Michael Jordan genuinely
spans sports and should decline. Non-players (`Checklist`, `Redemption`, `Title Card`, numeric
names) are filtered out by `isRealPlayer()`.

## settleIds() runs on every exit path
Sport resolution and the name→ID mappings live in `settleIds()`, called from **all three** exits of
`doLookup()` — the no-cert path, the non-Card-Hedger-grader path, and the Card Hedger path. It was
originally inline in the last of those, which meant an Arena Club card (no third-party cert, so it
returns early) silently skipped sport resolution, the system Set ID lookup and insert/subset
mapping. Any new early return must call it too.

## Brand-only registry rows are a last resort
A registry row whose only match token is its own brand — `Donruss`, `Select`, `Score`, `Playoff`,
`Panini Football` — is a catch-all, and used to win as a literal "exact" match. That made
`2024 Donruss Football` resolve to `FB DONRUSS` when `category` was set and `FB PD` when it wasn't:
the same card, two answers. Those rows now score below anything carrying a distinctive word, so
`2024 Donruss Football`, `2024 Panini Donruss Football` and `2024 Donruss` all give **`FB PD 2024`**.

Seven registry rows changed behaviour as a result (`BB DON→BB PD`, `BB SELECT→BB PS`,
`BB OPC→BB PEE`, `FB DONRUSS→FB PD`, `FB POFF→FB PPOFF`, `FB SCORE2→FB SCORE`, `FB PF→FB P`).
Confirm those are the intended canonical IDs; retiring or year-bounding the legacy brand-only rows
in 21088 would make it deterministic rather than something the matcher reasons around.

## Set ID: our system first, registry second
`lookupSetIdInSystem()` asks 30460 for another card in the same set and takes its `set_id`
verbatim. Only if that misses does `lookupSetId()` derive one from the registry.

That ordering exists because deriving guesses at the season format: the registry row for Fleer
Ultra has no year, so a 1996 card derives `BK FLRU 1996` where our system uses `BK FLRU 1996-97`.
Our own data is authoritative for our own IDs; the registry is the fallback for sets we've never
carried.

The registry matcher gained two things:
- a **brand-optional pass** — Card Hedger drops the manufacturer, so their "Donruss Optic" has to
  reach our "Panini Donruss Optic" (`FB PDOP`);
- a **sport-prefix guard** — a Set ID whose prefix doesn't match the card's sport is rejected. Without
  it, "2020 Donruss Optic Football" matched Soccer's `Donruss Optic` and returned `SCR DONOP 2020`.

## Name probe — when the insert is hiding in the set name
Metabase folds insert names into set names: `2022 Pokemon Japanese Dark Phantasma` is really the
**SWSH JPN set** plus the **Dark Phantasma insert** (`s10a`). Neither the registry nor a set-name
lookup can resolve that, because no set is called Dark Phantasma.

`insertNameCandidate()` strips the year, category and language words off the set name and
`lookupByName()` asks 30460 whether the remainder is a known insert name — its `insert_name`
filter is an `ILIKE '%…%'`, so a name probe works. The matching row supplies `set_id`,
`insert`, `insert_id` and `subset_id` in one go, and `set_id_source` is marked `name`.

A one-word remainder is too generic to probe with and is skipped. The probe only runs when
something is still missing after the normal lookups.

## Insert and Subset IDs
`lookupSetIdInSystem()`, `lookupInsertId()` and `lookupSubsetId()` each try several angles and take
the first that answers — set name, then insert/subset name, then **player + card number**. That
last one matters when the same card is catalogued twice under slightly different set names: the
copy with the IDs filled in is found by player and number even when the set name doesn't match.

Each scans **every** returned row, not just the first — the chosen row often lacks the field while
a sibling carries it. All attempts share the query cache, so the player+number probe is fetched
once and reused across all three lookups.


The Set ID registry has no insert data — `sport, brand, year, set_name, code, set_id` only. Insert
IDs live in the card table, so `lookupInsertId()` maps insert → `insert_id` by finding any other
card in the same set carrying that insert name (falling back to any set). `lookupSubsetId()` does
the same for subsets. Both need `insert_name` / `subset_name` as filter params on
`/api/card-match`.

## Where a suggested value can come from
**Any copy in the system that carries one, at any status.** Nothing in this app filters on status
or `is_in_component` — a sold, archived or in-process copy is as valid a source as a vaulted one.
(If 30460 itself restricts by status, that filter is upstream and invisible here.)

Choosing the copy that best *describes* the card and finding a *value* are separate steps:
`adoptSibling()` does the first, `findValuedCopy()` the second. Previously they were the same
step, so when the best-matching copy happened to be unvalued the search stopped there and the
panel showed no value even though other copies had one.

`findValuedCopy()` looks for an **exact** company+grade match first — in the copies returned with
the lookup, then across the rest of the system via `allCopiesFromSystem()` — and only accepts a
nearest-grade stand-in once both have come up empty. Stopping at the first valued copy in hand
gave an Arena Club 9.5 a CSG 9.5's $15 while its own Arena Club 9.5 twin sat at $25, absent from
the sibling set but one query away.

The chip filter resets on every new card (`lastCardKey`). Carrying a previous selection over meant
a lookup could land showing one row, or none, for no visible reason.

## Valuation dates
The copies table has a **Last est value date** column, sorted newest-first by default with undated
rows last. Every header is clickable — 8AC, Grade, Cert, date, value — and clicking the active one
flips direction; an arrow marks it. Undated rows stay pinned to the bottom in either direction,
since "no date" isn't older or newer than anything.

**14d / 30d / 90d** buttons window the table by valuation date. They're **always rendered**; when
no copy has a date they're disabled and labelled "no dates" rather than hidden, so the feature
doesn't look absent when it's merely inert. The window is applied **before**
the chips are built, so every count describes what's actually in range and a company chip covers
the grades it has *in that range* — chips for grades with nothing in the window disappear entirely
rather than advertising a count you can't see. The header reads e.g. "8 of 30 · last 30d". Clicking the active one clears it.
Undated rows drop out while a window is on — they can't satisfy "valued in the last 14 days" — and
the buttons only appear when at least one row has a date. It reads
`estimate_date`, normalised in `card-match.js` from explicit est-value timestamps only —
`estimated_value_updated_at`, `valued_at`, `recomped_at` and similar.

Source order: **`estimated_value_on`** first, then `estimated_value_at`. `updated_at` and
`fmv_updated_at` are deliberately never used — the first moves on any row edit including a rescan,
the second dates `fmv`, a different number. Dating a valuation with the wrong clock is worse than
showing none, so a row with no usable date shows "—" and sorts last.

`parseEstDate()` handles all three shapes 30460 emits, and reads the slash form as **US M/D/Y**:
`04/07/2026` is 7 April, not 4 July. Trusting `Date.parse` with that string would have ordered
those rows wrongly and silently. Display is normalised to `YYYY-MM-DD` to match the sales panel.

The Est./Suggested Value caption also carries the date — "Exact match · Arena Club 9.5 ·
8AC 3902111 · valued 2026-04-07" — so a borrowed number can be judged on age, not just grade.

## Suggested values
A value taken from another copy is rendered as **Suggested Value** — its own label, a dashed
border and a caption naming the source — never as the card's own **Est. Value**:

- `Exact match · Arena Club 9.5 · 8AC 3902111` — same card, same company, same grade
- `Nearest copy · Arena Club 8 · 8AC 3902120` — closest grade, no exact match available

**`$0.00` means "not valued yet", not "worth nothing".** No card in the vault is genuinely worth
zero, so `priced()` in `card-match.js` blanks any non-positive value before it leaves the API, and
the front end independently refuses to display or borrow one. Without this, a repack run where
every copy sits at `$0.00` would show "Est. Value $0" and offer "$0" to its twins as a confident
exact match. Sub-dollar values like `$0.50` are unaffected.

If `$0.00` and "reviewed, declined to value" are meant to be different states, they need to be
distinguishable in the column — right now every consumer of 30460 sees them identically.

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
