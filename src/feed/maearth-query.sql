WITH
patterns AS NOT MATERIALIZED (
  SELECT
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'::text AS rfc3339,
    '^[0-9]{4}-[0-9]{2}-[0-9]{2} ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?[+-]([01][0-9]|2[0-3])(:[0-5][0-9](:[0-5][0-9])?)?$'::text AS legacy,
    '^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$'::text AS did,
    '^at://did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]/org[.]hypercerts[.]collection/[a-zA-Z0-9._~:-]+$'::text AS project_uri,
    '^at://did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]/org[.]hypercerts[.]claim[.]activity/[a-zA-Z0-9._~:-]+$'::text AS activity_uri,
    '^at://did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]/org[.]hypercerts[.]context[.]attachment/[a-zA-Z0-9._~:-]+$'::text AS post_uri,
    -- Collection NSIDs read by this statement, named once.
    'org.hypercerts.context.attachment'::text AS attachment_nsid,
    'app.certified.graph.follow'::text AS follow_nsid,
    'app.certified.graph.entityFollow'::text AS entity_follow_nsid,
    'app.certified.feed.repost'::text AS repost_nsid,
    'org.hypercerts.collection'::text AS collection_nsid,
    -- The sort value is returned to clients and re-read as a cursor, so every
    -- effective timestamp must render as a valid four-digit-year atproto datetime.
    -- This floor applies to createdAt and indexed_at; the cutoff below keeps the
    -- top far under year 9999.
    timestamptz '0001-01-01 00:00:00+00' AS min_effective_at,
    -- Items dated later than the statement clock plus this skew are hidden, not
    -- re-dated: one clock reading and one skew constant serve the whole statement.
    statement_timestamp() + interval '5 minutes' AS latest_visible_at
),
-- Decode only the viewer's own graph records (did-first); never cap the resolved scope.
viewer_graph AS MATERIALIZED (
  SELECT source.collection, decoded.value->'subject' AS subject,
    decoded.value->>'subject' AS subject_text, decoded.value->'via' AS via
  FROM happyview_records AS source
  CROSS JOIN patterns
  CROSS JOIN LATERAL (
    SELECT CASE WHEN pg_input_is_valid(source.record, 'jsonb')
      THEN source.record::jsonb ELSE NULL::jsonb END AS value
    OFFSET 0
  ) AS decoded
  WHERE source.did = $1
    AND source.collection IN (patterns.follow_nsid, patterns.entity_follow_nsid)
    AND decoded.value->>'$type' = source.collection
),
followed_accounts AS MATERIALIZED (
  SELECT DISTINCT subject_text AS did
  FROM viewer_graph CROSS JOIN patterns
  WHERE collection = patterns.follow_nsid
    AND (via IS NULL OR via = 'null'::jsonb)
    AND jsonb_typeof(subject) = 'string'
    AND length(subject_text) <= 2048
    AND subject_text ~ patterns.did
),
-- Direct entity follows only: a mediated follow (non-null via) does not widen scope.
followed_project_candidates AS MATERIALIZED (
  SELECT DISTINCT subject->>'uri' AS uri
  FROM viewer_graph CROSS JOIN patterns
  WHERE collection = patterns.entity_follow_nsid
    AND (via IS NULL OR via = 'null'::jsonb)
    AND subject->>'$type' = 'app.certified.defs#recordSubject'
    AND jsonb_typeof(subject->'uri') = 'string'
    AND length(subject->>'uri') <= 8192
    AND subject->>'uri' ~ patterns.project_uri
),
-- A project is a current org.hypercerts.collection record whose JSON type is
-- 'project'. Missing, unparseable and other-typed (favorites, portfolio,
-- program, ...) records are not projects. Primary-key lookups by URI only.
followed_projects AS MATERIALIZED (
  SELECT candidate.uri, project.value->'items' AS items
  FROM followed_project_candidates AS candidate
  CROSS JOIN patterns
  JOIN happyview_records AS source
    ON source.uri = candidate.uri
    AND source.collection = patterns.collection_nsid
  CROSS JOIN LATERAL (
    SELECT CASE WHEN pg_input_is_valid(source.record, 'jsonb')
      THEN source.record::jsonb ELSE NULL::jsonb END AS value
    OFFSET 0
  ) AS project
  WHERE project.value->>'type' = 'project'
),
-- URIs that make a post "about" a followed project: the collection URI plus the
-- activity URIs listed in that collection's current items[]. URI match only.
project_subject_uris AS MATERIALIZED (
  SELECT uri FROM followed_projects
  UNION
  SELECT item.identifier->>'uri'
  FROM followed_projects CROSS JOIN patterns
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(followed_projects.items) = 'array'
      THEN followed_projects.items ELSE '[]'::jsonb END
  ) AS element
  CROSS JOIN LATERAL (SELECT element->'itemIdentifier' AS identifier) AS item
  WHERE jsonb_typeof(item.identifier->'uri') = 'string'
    AND length(item.identifier->>'uri') <= 8192
    AND item.identifier->>'uri' ~ patterns.activity_uri
),
-- The viewer plus every followed account. Rows authored by a member are
-- author-driven; every other row can only be target-driven.
members AS MATERIALIZED (
  SELECT did FROM followed_accounts
  UNION
  SELECT $1::text
),
-- The kinds filter selects collections before any record is read. A
-- target-driven scan is attempted only when its target set is non-empty.
selected_kinds AS MATERIALIZED (
  SELECT kind.collection, kind.has_targets
  FROM patterns
  CROSS JOIN LATERAL (VALUES
    ('post', patterns.attachment_nsid,
      EXISTS (SELECT 1 FROM project_subject_uris)),
    ('projectFollow', patterns.entity_follow_nsid,
      EXISTS (SELECT 1 FROM followed_projects)),
    ('accountFollow', patterns.follow_nsid,
      EXISTS (SELECT 1 FROM followed_accounts)),
    ('repost', patterns.repost_nsid, false)
  ) AS kind(name, collection, has_targets)
  WHERE cardinality($3::text[]) = 0 OR kind.name = ANY($3::text[])
),
-- Author-driven rows: one (did, collection) index probe per member and
-- selected collection; only those candidates are decoded, once.
author_rows AS (
  SELECT source.uri, source.cid, source.collection, source.did,
    source.indexed_at, decoded.value
  FROM members AS member
  CROSS JOIN selected_kinds AS kind
  JOIN happyview_records AS source
    ON source.did = member.did AND source.collection = kind.collection
  CROSS JOIN LATERAL (
    SELECT CASE WHEN pg_input_is_valid(source.record, 'jsonb')
      THEN source.record::jsonb ELSE NULL::jsonb END AS value
    OFFSET 0
  ) AS decoded
  WHERE $2::text IS NULL OR member.did = $2
),
-- Target-driven rows: strangers' follows of followed accounts or projects and
-- posts about followed projects. These cannot be found by author, so the
-- collection is scanned and each record is decoded once. Only rows that hit a
-- followed target (and are not already author-driven) are kept.
target_rows AS MATERIALIZED (
  SELECT source.uri, source.cid, source.collection, source.did,
    source.indexed_at, decoded.value
  FROM selected_kinds AS kind
  CROSS JOIN patterns
  JOIN happyview_records AS source ON source.collection = kind.collection
  CROSS JOIN LATERAL (
    SELECT CASE WHEN pg_input_is_valid(source.record, 'jsonb')
      THEN source.record::jsonb ELSE NULL::jsonb END AS value
    OFFSET 0
  ) AS decoded
  WHERE kind.has_targets
    AND ($2::text IS NULL OR source.did = $2)
    AND CASE source.collection
      WHEN patterns.attachment_nsid THEN
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(decoded.value->'subjects') = 'array'
              THEN decoded.value->'subjects' ELSE '[]'::jsonb END
          ) AS subject
          JOIN project_subject_uris AS target ON target.uri = subject->>'uri'
        )
        AND source.did NOT IN (SELECT did FROM members)
      WHEN patterns.entity_follow_nsid THEN
        decoded.value->'subject'->>'uri' IN (SELECT uri FROM followed_projects)
        AND source.did NOT IN (SELECT did FROM members)
      WHEN patterns.follow_nsid THEN
        decoded.value->>'subject' IN (SELECT did FROM followed_accounts)
        AND source.did NOT IN (SELECT did FROM members)
      ELSE false
    END
),
candidates AS (
  SELECT * FROM author_rows
  UNION ALL
  SELECT * FROM target_rows
),
classified AS (
  SELECT event.uri, event.cid, event.collection, event.did AS actor_did,
    event.indexed_at, event.value->>'createdAt' AS created_at,
    CASE event.collection
      WHEN patterns.attachment_nsid THEN 'post'
      WHEN patterns.entity_follow_nsid THEN 'projectFollow'
      WHEN patterns.follow_nsid THEN 'accountFollow'
      WHEN patterns.repost_nsid THEN 'repost'
    END AS kind,
    CASE WHEN event.collection = patterns.repost_nsid
      THEN field.subject_uri END AS reposted_post_uri,
    -- Follow targets are the values the selection predicates below already
    -- validated; each follow kind exposes only its own target.
    CASE WHEN event.collection = patterns.entity_follow_nsid
      THEN field.subject_uri END AS followed_project_uri,
    CASE WHEN event.collection = patterns.follow_nsid
      THEN field.subject_text END AS followed_did
  FROM candidates AS event
  CROSS JOIN patterns
  -- Each record's subject and via, projected once for the predicates below.
  CROSS JOIN LATERAL (
    SELECT event.value->'subject' AS subject,
      event.value->>'subject' AS subject_text,
      event.value->'subject'->>'uri' AS subject_uri,
      event.value->'via' AS via
  ) AS field
  WHERE event.value->>'$type' = event.collection
    AND CASE event.collection
      WHEN patterns.attachment_nsid THEN
        event.value->>'contentType' = 'update'
        AND (
          event.did = $1
          OR event.did IN (SELECT did FROM followed_accounts)
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(event.value->'subjects') = 'array'
                THEN event.value->'subjects' ELSE '[]'::jsonb END
            ) AS listed(value)
            JOIN project_subject_uris AS target ON target.uri = listed.value->>'uri'
          )
        )
      WHEN patterns.entity_follow_nsid THEN
        (field.via IS NULL OR field.via = 'null'::jsonb)
        AND field.subject->>'$type' = 'app.certified.defs#recordSubject'
        AND jsonb_typeof(field.subject->'uri') = 'string'
        AND field.subject_uri ~ patterns.project_uri
        AND (
          field.subject_uri IN (SELECT uri FROM followed_projects)
          OR (
            event.did IN (SELECT did FROM followed_accounts)
            AND EXISTS (
              SELECT 1
              FROM happyview_records AS project_record
              CROSS JOIN LATERAL (
                SELECT CASE WHEN pg_input_is_valid(project_record.record, 'jsonb')
                  THEN project_record.record::jsonb ELSE NULL::jsonb END AS value
                OFFSET 0
              ) AS project
              WHERE project_record.uri = field.subject_uri
                AND project_record.collection = patterns.collection_nsid
                AND project.value->>'type' = 'project'
            )
          )
        )
      WHEN patterns.follow_nsid THEN
        (field.via IS NULL OR field.via = 'null'::jsonb)
        AND jsonb_typeof(field.subject) = 'string'
        AND field.subject_text ~ patterns.did
        -- followedDid is returned and output-validated; an overlong DID would fail the page.
        AND length(field.subject_text) <= 2048
        AND (
          event.did IN (SELECT did FROM followed_accounts)
          OR field.subject_text IN (SELECT did FROM followed_accounts)
        )
      WHEN patterns.repost_nsid THEN
        event.did IN (SELECT did FROM followed_accounts)
        AND jsonb_typeof(field.subject->'uri') = 'string'
        AND field.subject_uri ~ patterns.post_uri
        -- repostedPostUri is output-validated as an at-uri. The pattern fixes the
        -- shape (so the whole URI stays under 8192 characters); this also bounds
        -- the DID authority to 2048 and the record key to 512, neither '.' nor '..'.
        AND length(split_part(field.subject_uri, '/', 3)) <= 2048
        AND length(split_part(field.subject_uri, '/', 5)) <= 512
        AND split_part(field.subject_uri, '/', 5) NOT IN ('.', '..')
        AND jsonb_typeof(field.subject->'cid') = 'string'
        AND field.subject->>'cid' <> ''
      ELSE false
    END
),
parsed AS (
  SELECT event.uri, event.cid, event.collection, event.actor_did, event.kind,
    event.reposted_post_uri, event.followed_project_uri, event.followed_did,
    CASE WHEN event.created_at ~ patterns.rfc3339
      AND event.created_at !~ '-00:00$'
      AND pg_input_is_valid(event.created_at, 'timestamptz')
      THEN event.created_at::timestamptz END AS created_ts,
    CASE WHEN (event.indexed_at ~ patterns.rfc3339 OR event.indexed_at ~ patterns.legacy)
      AND event.indexed_at !~ '-00(:00(:00)?)?$'
      AND pg_input_is_valid(event.indexed_at, 'timestamptz')
      THEN event.indexed_at::timestamptz END AS indexed_ts
  FROM classified AS event CROSS JOIN patterns
),
-- A createdAt that parses as a real timestamp (year 1 onward) is the item's
-- time even beyond year 9999; `paged` then hides it as future-dated and never
-- replaces it. Only an unparseable createdAt, or one before year 1, falls back
-- to indexed_at; when that is before year 1 (or absent/invalid) the row is
-- excluded.
timed AS (
  SELECT event.uri, event.cid, event.collection, event.actor_did, event.kind,
    event.reposted_post_uri, event.followed_project_uri, event.followed_did,
    COALESCE(
      CASE WHEN event.created_ts >= patterns.min_effective_at
        THEN event.created_ts END,
      CASE WHEN event.indexed_ts >= patterns.min_effective_at
        THEN event.indexed_ts END
    ) AS effective_at
  FROM parsed AS event CROSS JOIN patterns
),
paged AS (
  SELECT timed.* FROM timed CROSS JOIN patterns
  WHERE effective_at IS NOT NULL
    AND effective_at <= patterns.latest_visible_at
    AND (cardinality($3::text[]) = 0 OR kind = ANY($3::text[]))
    AND ($4::timestamptz IS NULL OR (effective_at, uri) < ($4::timestamptz, $5::text))
  ORDER BY effective_at DESC, uri DESC
  LIMIT $6::integer
)
SELECT uri, cid, collection, actor_did, kind, reposted_post_uri,
  followed_project_uri, followed_did,
  to_char(effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_value
FROM paged
ORDER BY effective_at DESC, uri DESC
