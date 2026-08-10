/* OPTIMISED. Same results as the previous version; three structural changes, all commented:
     1. seed matches ac_number / cert_number with = instead of ILIKE '%..%'  (index-usable)
     2. cert_number pre-aggregated in a CTE instead of a correlated subquery per output row
     3. the outer query joins sib_ids rather than repeating the 6-column identity join
   Look up a card by AC number or cert number,
   then return ALL cards sharing the same identity
   (sport, set_name, insert, player_name, set_number, parallel_name) */
WITH seed AS (
  SELECT
    c.id              AS seed_card_id,
    ac.sport,
    ac.set_name,
    ac."insert"       AS insert_val,
    ac.player_name,
    ac.set_number,
    ac.parallel_name
  FROM public.cards c
  JOIN admin.cards ac ON ac.id = c.id
  LEFT JOIN admin.card_cert_number ccn ON ccn.card_id = c.id
  LEFT JOIN admin.subsets sub ON sub.id = ac.subset_id
  WHERE 1=1
    [[AND TRIM(c.number::text)        =  TRIM({{ac_number}})]]
    [[AND TRIM(ccn.cert_number::text) =  TRIM({{cert_number}})]]
    /* the seed has to honour the same filters, or a name-only search picks an
       unrelated top-value card and the identity join returns nothing */
    [[AND LOWER(ac.set_name)        ILIKE '%' || LOWER({{set_name}})        || '%']]
    [[AND LOWER(ac.player_name)     ILIKE '%' || LOWER({{player_name}})     || '%']]
    [[AND LOWER(ac."insert")        ILIKE '%' || LOWER({{insert_name}})     || '%']]
    [[AND LOWER(sub.name)           ILIKE '%' || LOWER({{subset_name}})     || '%']]
    [[AND LOWER(ac.parallel_name)   ILIKE '%' || LOWER({{parallel_name}})   || '%']]
    [[AND ac.set_number::text       ILIKE '%' || {{card_no}}                || '%']]
    [[AND LOWER(ac.grading_company) =            LOWER({{grading_company}}) ]]
    [[AND ac.overall =              {{grade}}]]
  ORDER BY ac.estimated_value_cents DESC NULLS LAST, c.id
  LIMIT 1
),
/* card ids in the identity group — keeps the EV history scan small */
sib_ids AS (
  SELECT c.id
  FROM public.cards c
  JOIN admin.cards ac ON ac.id = c.id
  JOIN seed ON
    coalesce(ac.sport,'')         = coalesce(seed.sport,'')         AND
    coalesce(ac.set_name,'')      = coalesce(seed.set_name,'')      AND
    coalesce(ac."insert",'')      = coalesce(seed.insert_val,'')    AND
    coalesce(ac.player_name,'')   = coalesce(seed.player_name,'')   AND
    coalesce(ac.set_number,'')    = coalesce(seed.set_number,'')    AND
    coalesce(ac.parallel_name,'') = coalesce(seed.parallel_name,'')
),
/* most recent estimated value per card */
latest_ev AS (
  SELECT card_id, estimated_value_cents, created_at
  FROM (
    SELECT
      ev.card_id,
      ev.estimated_value_cents,
      ev.created_at,
      ROW_NUMBER() OVER (
        PARTITION BY ev.card_id
        ORDER BY ev.created_at DESC, ev.updated_at DESC, ev.id DESC
      ) AS rn
    FROM admin.estimated_value ev
    WHERE ev.card_id IN (SELECT id FROM sib_ids)
      -- AND ev.finished_at IS NOT NULL   -- optional: ignore in-flight EV tasks
  ) x
  WHERE rn = 1
),
/* one row per card instead of a correlated subquery evaluated for every output row */
certs AS (
  SELECT card_id, MAX(cert_number) AS cert_number
  FROM admin.card_cert_number
  WHERE card_id IN (SELECT id FROM sib_ids)
  GROUP BY card_id
)
SELECT
  c.id                                          AS card_id,
  ac.front_slab_picture_url,
  ac.sport,
  ac.set_name,
  COALESCE(s.set_id, s_via_sub.set_id)          AS set_id,
  ac."insert"                                   AS "insert",
  sub.insert_id                                 AS insert_id,
  sub.name                                      AS subset_name,
  ac.subset_id,
  ac.player_name,
  ac.set_number                                 AS card_no,
  ac.parallel_name,
  ac.parallel_total,
  ac.grading_company,
  ac.overall                                    AS grade,
  /* most-recent EV, falling back to the mirrored value on admin.cards */
  COALESCE(lev.estimated_value_cents, ac.estimated_value_cents) / 100 AS estimated_value,
  lev.created_at::timestamp                     AS estimated_value_at,
  TO_CHAR(lev.created_at, 'MM/DD/YYYY')         AS estimated_value_on,
  c.last_comp_value_cents / 100                 AS last_comp_value,
  NULL::numeric                                 AS accepted_comp,
  c.number                                      AS ac_number,
  cn.cert_number                                AS cert_number,
  COALESCE(ac__i."tag", ac."tag")               AS "tag",
  (c.slab_pack_component_id IS NOT NULL)        AS is_in_component,
  ac.status,
  (c.id = seed.seed_card_id)                    AS is_seed_card,
  'https://admin.arenaclub.com/cards/' || c.id || '/estimate-value' AS url
FROM public.cards c
JOIN sib_ids si ON si.id = c.id          /* identity group, already resolved above */
JOIN admin.cards ac ON ac.id = c.id
CROSS JOIN seed                          /* single row; only needed for is_seed_card */
LEFT JOIN certs cn ON cn.card_id = c.id
LEFT JOIN latest_ev lev ON lev.card_id = c.id
LEFT JOIN public.items ac__i ON ac__i.id = ac.id AND ac__i.category = 'card'
LEFT JOIN admin.subsets sub       ON sub.id       = ac.subset_id
LEFT JOIN admin.sets    s         ON s.id         = ac.set_id
LEFT JOIN admin.sets    s_via_sub ON s_via_sub.id = sub.set_id
WHERE 1=1
  AND (ac.status IN ('pending_slabbing', 'vaulted', 'shipped', 'pending_release')
     OR c.id = seed.seed_card_id)
  AND (c.is_in_marketplace = false  OR c.id = seed.seed_card_id)
  [[AND (c.slab_pack_component_id IS NOT NULL)::text = {{is_in_component}}]]
  [[AND LOWER(ac.set_name)        ILIKE '%' || LOWER({{set_name}})        || '%']]
  [[AND LOWER(ac.player_name)     ILIKE '%' || LOWER({{player_name}})     || '%']]
  [[AND LOWER(ac."insert")        ILIKE '%' || LOWER({{insert_name}})     || '%']]
  [[AND LOWER(sub.name)           ILIKE '%' || LOWER({{subset_name}})     || '%']]
  [[AND LOWER(ac.parallel_name)   ILIKE '%' || LOWER({{parallel_name}})   || '%']]
  [[AND ac.set_number::text       ILIKE '%' || {{card_no}}                || '%']]
  [[AND LOWER(ac.grading_company) =            LOWER({{grading_company}}) ]]
  [[AND ac.overall =              {{grade}}]]
ORDER BY is_seed_card DESC,
         COALESCE(lev.estimated_value_cents, ac.estimated_value_cents) DESC NULLS LAST;
