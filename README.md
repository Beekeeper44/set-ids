# Set IDs → Vercel

A single-page Set ID registry (dark terminal theme) that syncs live from the
Metabase question **21088 "set-ids"** through a small serverless proxy.

```
set-ids/
├─ index.html          the app (calls /api/set-ids on load and on ↻ Metabase)
├─ api/
│  └─ set-ids.js       serverless proxy → Metabase (keeps the API key server-side)
├─ package.json
├─ vercel.json
└─ README.md
```

## Why the proxy?
A browser can't call the authenticated Metabase API directly — CORS blocks it and
the API key must never be shipped in a public file. The `/api/set-ids` function runs
on Vercel's server, holds the key in an environment variable, calls Metabase, and
returns clean JSON rows to the app on the **same origin** (no CORS).

If the proxy is unreachable (e.g. running the file locally), the app quietly falls
back to its built-in seed data and shows **○ offline (seed data)**.

## 1. Get a Metabase API key
In Metabase: **Admin settings → Authentication → API keys → Create API key**
(or **Settings → API keys**, depending on version). Assign it to a group that can
see question 21088. Copy the key.

## 2. Deploy

### Option A — Vercel dashboard (no CLI)
1. Push this folder to a GitHub repo (or drag-drop it in the Vercel dashboard).
2. **New Project → Import** the repo. Framework preset: **Other** (no build step).
3. **Settings → Environment Variables**, add:
   - `METABASE_API_KEY` = your key  (required)
   - `METABASE_URL` = `https://arena-club.metabaseapp.com`  (optional)
   - `METABASE_CARD_ID` = `21088`  (optional)
4. **Deploy.**

### Option B — Vercel CLI
```bash
npm i -g vercel
cd set-ids
vercel                      # first deploy / link project
vercel env add METABASE_API_KEY     # paste the key, choose Production (+ Preview)
vercel --prod               # deploy to production
```

## 3. Verify
- Visit your deployment URL → the status pill should read **● Metabase live**.
- Hit `/api/set-ids` directly → you should see a JSON array of rows.
- The **↻ Metabase** button re-pulls the latest data on demand.

## Column mapping
The proxy normalizes Metabase's columns into the shape the app reads:

| Metabase column   | App field        |
|-------------------|------------------|
| `sport`           | sport (→ pill)   |
| `brand`           | brand            |
| `year`            | year             |
| `set_name`        | set              |
| `code`            | code             |
| `set_id`          | set_id (shown verbatim) |
| `set_created_at`  | created          |

Sport values like `one_piece`, `star_wars`, `yugioh`, `combat` are matched to the
app's display categories automatically; unknown sports are added rather than dropped.

## Notes
- Filtering (sport / brand / year / search) happens in the browser, so the proxy
  fetches all rows and Vercel edge-caches them for ~60s.
- To extend the year picker beyond 2026, bump `YEAR_MAX` near the top of the
  `<script>` in `index.html`.
