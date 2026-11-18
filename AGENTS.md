# Hypercerts Feed Service agent guide

## Read this first

This repository is a standalone, read-only TypeScript service exposing two POST procedures with optional AT Protocol service authentication:

```text
org.hypercerts.feed.getFeedSkeleton
org.hypercerts.feed.getFeed
```

The skeleton returns `{ uri }` items, the AT-URI of each item's own record. The hydrated endpoint returns one flat `itemView` per record (`uri`, `cid`, `author`, `kind`, `sortAt`, and where they apply `createdAt`, `subject`, counts and `content`); the Hypercerts feed hydrates the author and validated card `content`. HappyView is the database owner. The service reads its current PostgreSQL state directly; it does not ingest, write records, own migrations, cache feed results across requests, call HappyView/PDS/AppView APIs, download blobs, hydrate target records, or provide immutable history. Optional service auth verifies the issuer's `#atproto` signing key, audience, expiry, endpoint binding, and DID document over a bounded secure resolver; the verified issuer, never the body, supplies an authenticated viewer. It retains only bounded, process-local replay-protection state through the JWT `jti`; that state is not a feed-result cache.

**Experimental MaEarth carve-out.** When `MAEARTH_FEED_ENABLED=true` (default off) the service also registers `org.hypercerts.feed.defs#maearthFeed` (`src/feed/maearth.ts`, `src/feed/maearth-query.sql`, the MaEarth section of `docs/api.md`). Both feeds return the same flat `itemView`, and both expose the effective sort timestamp as `sortAt`, exactly the value that orders the page and that the cursor encodes. MaEarth's `getFeed` items carry merge metadata and counts instead of hydrated content, with no identity batch: `uri`; `cid`; `author` (`{ did }` only, the record's author); `kind` (`update`, `repost`, `project-follow`, `account-follow`); `sortAt`; the item record's own `createdAt` text, unchanged and omitted unless it is a valid atproto datetime (never replaced by the sort time or `indexed_at`); a `subject` that mirrors the record's own `subject` (a `recordView` for a repost, carrying the CID the repost names, omitted when it is not a valid CID, and the original post's counts, and for a project follow, with `uri` only; an `actorView` `{ did }` for an account follow; none for an update); and, on `update` items only, the item's own `likeCount`, `repostCount` and `replyCount`. `author` and `subject` are named open objects (`#actorView`, `#recordView`) that clients must tolerate growing; this service sets exactly the subject its kind needs. It also hides rows whose effective timestamp is later than the database's statement time plus five minutes (excluded, never re-dated); the Hypercerts feed has no such cutoff. Its skeleton stays `{ uri }`-only. Every invariant below that mentions hydration, `content`, or "classification metadata" describes the Hypercerts feed unless it says otherwise. MaEarth does not relax read-only, one-statement, cursor, or error-safety rules. Its only reads beyond the selected records are, in the same statement: primary-key lookups of `org.hypercerts.collection` records (the viewer's followed projects, to resolve scope, and the collections named by followed accounts' entity follows, to check they are projects) and, for `getFeed` only, the counts lookup: after pagination, the like, repost and comment-attachment records that HappyView's `happyview_record_refs` (index on `(target_uri, collection)`) lists for the page's posts, each fetched by primary key and re-checked (`$type`, `subject.uri` or `subjects[].uri`, distinct DIDs for likes and reposts, every direct comment for replies; an update counts itself, a repost its original post with the numbers on its `subject`, follows none). Counts never enter ordering or the cursor, and the skeleton skips the lookup's work but still runs the same statement, so both MaEarth endpoints fail until the feed role has `SELECT` on `happyview_record_refs`; grant it before deploying. The service never reads repost targets or post subjects as records, and it hydrates nothing. Do not "fix" MaEarth toward the Hypercerts shape, or the reverse, without updating both documents.

Use **npm**, not pnpm. `package-lock.json` is authoritative. Node.js 22.19+ is supported; CI and Docker use Node.js 24. PostgreSQL 16+ is required.

Before changing feed behavior, read together:

- `src/feed/feed-query.sql` — primary selection, classification, ordering, pagination, and same-statement source contract
- `src/feed/query.ts` — registered HappyView-backed Hypercerts feed definition, fixed SQL bind order, row mapping, and source invariants
- `src/feed/registry.ts` and `src/feed/sql-feed.ts` — feed dispatch plus shared parsing, cursor, execution, pagination, and metrics policy
- `test/feed.integration.test.ts` — cross-table, source-mode, and pagination invariants
- `docs/database-contract.md` — HappyView schema, current-state, and label-projection contract
- for the MaEarth feed, in addition to the shared `src/feed/registry.ts` and `src/feed/sql-feed.ts`: `src/feed/maearth-query.sql`, `src/feed/maearth.ts`, `test/maearth.integration.test.ts`, and the MaEarth section of `docs/api.md`

## Commands

```bash
npm install                    # local setup; use npm ci for a clean reproducible install
npm run dev                    # watch TypeScript and src/feed/feed-query.sql
npm run codegen                # regenerate ignored Lexicon TypeScript
npm run lint                   # codegen via prelint, then strict typed ESLint
npm run lint:fix               # apply ESLint autofixes
npm run format                 # format maintained TS/MJS/MD/YAML/JSON files
npm run format:check           # verify Prettier formatting
npm run changeset              # add a versioned release-note fragment
npm run changeset:empty        # add a no-version-bump fragment
npm run check                  # strict TypeScript check
npm test                       # unit tests; equivalent to npm run test:unit
npm run build                  # codegen, compile, copy SQL, smoke-load production adapters
```

Integration tests require an explicitly chosen empty disposable PostgreSQL 16+ database:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration
```

To test against an isolated database already migrated with HappyView's schema:

```bash
TEST_DATABASE_URL='postgresql://...' npm run test:integration:happyview
```

Never target a shared, staging, or production database. The suite creates contractual tables and rows but does not drop or truncate existing tables. `test:integration:happyview` requires `psql`, checks the HappyView columns used by the service, then runs the behavior suite. The suite writes synthetic records and labels and does not apply migrations. It does not test real record or label ingestion; never target a shared, staging, or production database.

CI and exact-commit release validation run:

```text
npm ci -> npm run codegen -> npm run lint -> npm run format:check -> npm run check -> npm test -> npm run test:integration -> npm run build
```

`npm run lint` also regenerates ignored Lexicon TypeScript through its `prelint` hook, so typed lint works from a fresh checkout. ESLint prohibits inline configuration (including disable comments) globally and bans `@ts-expect-error`, `@ts-ignore`, and `@ts-nocheck` in maintained TypeScript. ESLint excludes generated Lexicons, build output, coverage, dependencies, pinned external Lexicons, and release changelogs. Prettier formats maintained TypeScript, MJS, Markdown, YAML, project configs, and project-owned feed Lexicons; `.prettierignore` excludes generated output, external pinned Lexicons, the lockfile, and release changelogs. SQL, Bruno `.bru`, shell, Dockerfile, and environment files are not formatted by these commands.

Follow existing code style: ESM, NodeNext `.js` import suffixes, single quotes, no semicolons, narrow interfaces, and no unrelated reformatting. Use `npm run format` only for the maintained file set listed above; never format generated or pinned external artifacts.

## Architecture and ownership

Skeleton call stack:

```text
src/server.ts
  -> src/app.ts
  -> src/api/get-feed-skeleton.ts
  -> FeedService
  -> FeedRegistry.loadPage(metadata)
  -> registered HappyView-backed SQL feed
  -> src/feed/feed-query.sql, source mode disabled
  -> Database
```

Hydrated call stack:

```text
src/server.ts
  -> src/app.ts
  -> src/api/get-feed.ts
  -> HydratedFeedService
  -> FeedRegistry.loadPage(with-source)
  -> registered HappyView-backed SQL feed
  -> src/feed/feed-query.sql, source mode enabled
  -> validateFeedRecord(), dropping invalid selected sources
  -> IdentityReader.getByDids()
  -> validateCertifiedProfile()
  -> buildActorView() / buildItemSubject() / buildItemContent()
```

Ownership:

- `src/server.ts` is the composition root. It creates the registered Hypercerts feed, one shared registry, separate endpoint services, one identity adapter, and the configured optional service-auth verifier; that verifier owns one replay map shared by both endpoints; it also owns listener settings, initial readiness, and graceful shutdown.
- `src/app.ts` is the fetch-compatible boundary. It owns fixed route metadata, POST enforcement, the 64 KiB body limit, malformed JSON, routed validation messages, and bounded request metrics.
- `src/api/get-feed-skeleton.ts` and `src/api/get-feed.ts` register the procedures, run generated output validation inside the error boundary, and translate expected `FeedError` values.
- `src/feed/service.ts` projects registry-selected metadata rows into the public skeleton. It does not own dispatch, cursor, or pagination policy.
- `src/feed/registry.ts` owns `feedId` dispatch, feed/params compatibility checks, and the shared metadata/source page interface used by both endpoint services.
- `src/feed/sql-feed.ts` owns feed-specific parameter parsing and normalization calls, feed-scoped cursor decoding, one query execution/timing, `limit + 1` trimming, result metrics, source-mode enforcement, and next-cursor creation.
- `src/feed/query.ts` registers the current HappyView-backed Hypercerts feed and owns its generated parameter parsing, fixed SQL bind order, metadata/source row mapping, and explicit query invariants.
- `src/feed/feed-query.sql` owns scope resolution, quality and endorsement rules, project pairing, classification, ordering, keyset pagination, and the conditional post-pagination source join.
- `src/feed/maearth.ts` and `src/feed/maearth-query.sql` register the optional MaEarth feed: parameter parsing, fixed bind order, row mapping, and one statement that resolves the viewer graph, project records, selection, timestamp bounds, the future-dated cutoff, keyset pagination and, for `getFeed`, post and repost counts. `MaearthFeedService` returns the items its row mapper built from source-mode rows, after checking them against the `itemView` Lexicon.
- `src/hydration/router.ts` maps feedIds that own their row kinds (MaEarth) to their own hydrator; every other feedId reaches `HydratedFeedService`, which throws an internal error on a row kind it does not serve instead of dropping it.
- `src/hydration/service.ts` directly coordinates source validation, omission of invalid selected sources, DID discovery, at most one identity batch, identity projection, total item construction, and output ordering. It must not call the public skeleton service.
- `src/hydration/identity.ts` owns the batched current Certified-profile query and returns one context per requested DID.
- `src/hydration/validation.ts` owns strict source/profile validation. `src/hydration/views.ts` owns pure identity precedence and the kind-specific `content` and `subject` construction. Neither performs I/O.
- `src/database.ts` is the only PostgreSQL pool owner.
- `src/metrics.ts` owns an isolated Prometheus registry with bounded labels.

## Test seams

Test at the narrowest owner:

- app tests fake `FeedSkeletonReader` and `HydratedFeedReader`;
- skeleton-service tests fake `FeedPageLoader`;
- hydrated-service tests fake `FeedPageLoader` and `IdentityReader`;
- registry tests fake registered feeds and assert dispatch invariants;
- generic SQL-feed tests fake the query executor and assert parsing, cursor, pagination, mode, timing, and metrics policy;
- Hypercerts-feed and MaEarth-feed query tests fake the query executor and assert bind/source invariants;
- hydrated-router tests assert feedId dispatch;
- identity tests fake its query executor;
- validation and views use pure fixture tests;
- Lexicon tests inspect committed JSON and generated parsers;
- PostgreSQL integration tests own SQL, schema, cross-table, source-mode, and pagination behavior.

## Release workflow

Add a Changeset when a pull request affects application behavior, runtime configuration, the public contract, supported runtime versions, service deployment, or operator procedures. This includes changes to feed selection, filtering, pagination, hydration, request parameters, responses, and public errors. Do not add a Changeset for local development tools, tests, behavior-preserving internal refactors, documentation-only corrections, or repository and CI maintenance that does not affect the service or its operators. CI does not infer semantic release impact; contributors and reviewers own this decision. When a pull request does include a Changeset fragment, CI validates it with `changeset status` so malformed release metadata cannot reach `main`.

Changesets creates or updates the `changeset-release/main` Release pull request with `GITHUB_TOKEN`. Current GitHub behavior creates its CI runs in an approval-required state. A maintainer must approve those runs and wait for the full PostgreSQL-backed CI suite before merging. The release workflow then validates the exact merged commit before creating the private package's Git tag and GitHub Release. It does not publish to npm or deploy the service. See `docs/RELEASING.md` for the complete flow.

## Canonical and generated files

- Project-owned `lexicons/org/hypercerts/feed/**/*.json` is the public wire contract. Active external Lexicon dependencies are pinned by `lexicons.json`; refresh them only through `lex install`. `lexicons/app/bsky/actor/profile.json` is preserved locally but is no longer an active dependency or used by identity hydration.
- `src/lexicons/` is generated and ignored. Never hand-edit or commit it.
- `src/feed/feed-query.sql` is the canonical feed statement.
- `dist/` and `coverage/` are generated and ignored.
- `npm run build` must copy the feed SQL beside `dist/feed/query.js` and smoke-load every production adapter without starting the server.

The current `@atproto/lex` generator emits explicit `l.typedObject<T>` and `l.record<Key, T>` calls whose optional fields are incompatible with this repository's `exactOptionalPropertyTypes: true`. `npm run codegen` therefore runs `scripts/fix-generated-feed-defs.mjs`, which removes only those explicit schema generics from ignored generated definitions. It does not change Lexicon JSON or runtime validators. Keep the workaround narrow. Remove the script and package-script hook only after an upstream generator version supports exact optional properties and `npm run check`, parser contract tests, and `npm run build` pass without it.

A request, response, event kind, item field, or public-error change normally requires coordinated updates to Lexicon JSON, domain types, service behavior, tests, and README. A schema-dependent change normally requires SQL, bind mapping, integration-test, and database-contract updates.

## Feed and hydration invariants

Preserve these unless the public contract is intentionally revised and documented:

- Both procedures accept the same `{ feedId, params?, limit?, cursor? }` wrapper. `limit` and `cursor` are generic top-level pagination controls; `params` contains only algorithm-specific values and may be omitted for feeds that declare no params contract. The public params union remains open for future feeds. Runtime dispatch rejects an unregistered `feedId` with `UnsupportedFeed`, while the current Hypercerts feed rejects missing params or a mismatched params discriminator with `InvalidRequest` before querying.
- The base scope always resolves from the normalized viewer's current Certified follows. Anonymous requests require `params.viewerDid`; authenticated requests may omit it, but a supplied value must exactly match the verified service-auth issuer. There is no caller-supplied author override or body-based override of authenticated identity.
- Authenticated tokens must carry a non-empty string `jti` of 1–256 UTF-8 bytes. After successful signature and exact `lxm` verification, each issuer-and-`jti` pair is consumed once in the shared process-local replay map, with a maximum of 512 live entries per verified issuer and 4,096 live entries total. Expired entries are purged without evicting live entries; a live full issuer quota or global map fails closed with HTTP 503. The map is cleared on restart and is not replica-global. Downstream failures do not restore a consumed token.
- Deduplicate request lists before enforcing semantic limits: 64 evaluators, 16 kinds, and 1–50 page items.
- Evaluator endorsement subjects are unioned after base-author resolution. Remove the viewer and deduplicate candidates. Do not query actor status: only current records present in HappyView affect feed selection.
- Omitted or empty `kinds` means all supported kinds. Unknown kinds fail with the generic `InvalidRequest` error and an actionable Hypercerts-parameter message.
- Organization-quality policy uses only service-configured `TRUSTED_QUALITY_LABELER_DIDS`. Organizations are exact `app.certified.actor.organization/self` records. Quality labels are trusted bare-DID rows in HappyView's current positive `happyview_labels` projection; `cts` and `exp` are TEXT and must be complete finite RFC3339 or legacy PostgreSQL timestamp strings. Validate shape and `pg_input_is_valid` before casting; malformed, date-only, and nonfinite values are inactive. `cts` is not used for ordering. HappyView removes negated rows and stores no label CID or history. Direct SQL fixtures do not prove stream ingestion or label completeness. `includeUnrated` applies only when no active trusted label exists; an active disallowed label is not unrated.
- Materialize the complete resolved scope once for project pairing and event selection. Do not cap or truncate followed or evaluator-expanded accounts.
- Evaluator expansion and visible endorsement events use the same JSON account-subject, self-endorsement, exact definition URI/CID, badge type, allowed-issuer, and latest exact response rules. Do not use derived endorsement adjacency data.
- Project/activity pairing happens before kind filtering and pagination. It requires the same actor, exact activity URI/CID, and an effective timestamp gap strictly below 60 seconds. Paired activities remain suppressed across pages.
- HappyView stores `record`, `indexed_at`, `created_at`, `cts`, and `exp` as TEXT. Parse JSON and timestamp text only in per-consumer guarded projections; require complete RFC3339 or legacy PostgreSQL timestamp shape, validate with `pg_input_is_valid`, and reject nonfinite values before casting. Invalid JSON is absent, malformed `createdAt` falls back to finite parsed `indexed_at`, and null, malformed, date-only, or nonfinite fallback timestamps do not enter the feed. Compare parsed timestamp values chronologically, never TEXT lexically. Ordering is effective timestamp descending, URI descending, over effective timestamps from year 0001 through 9999 UTC (the Hypercerts feed excludes rows outside, never re-dating them to `indexed_at`; MaEarth does the same above year 9999 but falls back to a valid `indexed_at` for a `createdAt` before year 1); `happyview_records.created_at` is ingestion time and is not used.
- The cursor payload is unpadded base64url JSON with exactly `{ version: 1, feedId, value: { value, uri } }`. It is scoped to the selected feed and stores the last selected source row before hydration. Ordering, formatting, tie-break, and cursor payload are one contract; dropping invalid hydrated sources must not change cursor advancement.
- Metadata and source-aware pages execute the registered feed statement once. Source JSON is joined only after `paged_events`; never carry it through candidate sorting.
- Feed selection and exact source retrieval share one PostgreSQL statement snapshot. A missing/mismatched final join is an internal invariant failure.
- Skeleton pages execute one feed query and expose only `{ uri }` items, with no CID, kind, time, or source value. Hydrated pages with at least one validated source execute one feed/source statement plus one identity query. Empty or entirely invalid selected pages skip identity retrieval. Do not issue extra queries to refill dropped items; query count never grows with page size.
- Identity retrieval is a later current-state read. One batch selects only the current Certified profile record from `happyview_records`; do not join handles, Bluesky profile records, or actor status.
- Every requested identity DID receives a context. Missing storage rows degrade to a DID-only summary; query rejection fails the request.
- A valid meaningful Certified profile supplies supported display/avatar fields; otherwise the account's `actorView` is DID-only. Do not expose provenance or handle/Bluesky fallbacks.
- Known source records validate against `@hypercerts-org/lexicon` exactly `1.0.0`, selected by trusted collection plus feed kind. Keep the compatible direct `@atproto/lexicon` pin and supplemental MIME, integer-size, nonnegative-size, and maximum-size checks.
- Public hydrated output is one flat `org.hypercerts.feed.defs#itemView` per record, with no envelope and no feed-specific view type. Only `uri`, `author`, `kind` and `sortAt` are required; every object and union is open and clients must tolerate unknown fields and variants. `uri` and `cid` name the item's own record; `author` is the `actorView` of the record's author (the authority of `uri`); `kind` is kebab-case; `sortAt` equals the sort value the cursor encodes, so never derive it separately from the ordering, and both feeds' SQL must keep that value within years 0001 through 9999 UTC so `sortAt` and the cursor stay valid datetimes (the Hypercerts feed excludes, never re-dates, rows outside it; MaEarth excludes above year 9999 and falls back to `indexed_at` for a `createdAt` before year 1); `createdAt` is the record's own value, unchanged, omitted when unusable. `subject` mirrors the record's own single `subject` field (`recordView` or `actorView`) and is not set for records without one; counts on the item always count the item's own `uri`. Drop invalid selected sources without backfilling; a hydrated page may be shorter than `limit`, or empty, while retaining the selected-page cursor. Do not expose source JSON or redundant event-author DID fields; the CID is the selected row's own, never a newer record's.
- Hydrated items reference `org.hypercerts.feed.defs#itemView` directly from `getFeed`, and skeleton items `#skeletonItem` from `getFeedSkeleton`. `subject` and `content` values and image values remain open unions. Preserve protocol-native `org.hypercerts.defs#uri`, `#smallImage`, `#largeImage`, and `#smallBlob` discriminators and nested AT Protocol blob refs; never add a feed-specific flattened blob descriptor. Require clients to tolerate unknown future variants.
- All seven supported Hypercerts kinds map to five known `content` variants plus none: both collection kinds use `collectionView`, and an endorsement has no `content` because its account is the item's `subject`. The service owns this kind/content mapping. Item `kind` values and the `kinds` request parameter use the same kebab-case names in both feeds; the previous dotted and camelCase names are rejected.
- An endorsement item's `subject` is the endorsed account as an `actorView` with the exact Certified-profile fields discovered for it.
- Evaluation `subject` and measurement and update `content.subjects[]` entries are exact strong references only (`uri` and `cid`); a record whose built item fails the generated `itemView` check (a reference URI such as a `..` record key, or a lenient `startDate`) is an invalid source and is dropped (cursor unchanged), because one bad value would otherwise fail the whole page; the check runs before the identity batch, and the item's `createdAt` is omitted instead when only it fails the datetime format. Do not query target records, discover target identities, build previews, or recurse.
- Results are mutable current state, not snapshots across requests or an event log.

## Database and operational safety

HappyView owns `happyview_records`, `happyview_labels`, `happyview_record_refs` (read only by the MaEarth feed, for counts, and it must be complete), their migrations, and indexes. This repository must not apply migrations, create indexes, refresh materialized views, or write cursor state. Parameterize every caller-controlled SQL value. Index changes belong in HappyView and require production-shaped `EXPLAIN (ANALYZE, BUFFERS)` evidence.

Use a deployment role with `SELECT` only. `default_transaction_read_only=on` is defense in depth, not a grant replacement.

`GET /ready` checks reachability, PostgreSQL 16 safe JSON/timestamp input-validation support, and read-only session state. It intentionally does not verify HappyView tables, migration completeness, labeler subscription health, label completeness, or ingestion freshness. `GET /health` is process liveness only.

`REQUEST_TIMEOUT_MS` bounds receiving a request, not total handler/query duration. Pool acquisition and statement timeouts are separate.

Keep errors actionable and stable without exposing SQL, credentials, contents, internal causes, or stacks. Never use DIDs, AT-URIs, CIDs, cursors, or record values as metric labels.

Rate limiting belongs at the gateway. Keep `/health` and `/ready` private.

## MVP exclusions

Do not add ingestion, writes, stronger authentication modes, feed-result caching across requests, immutable history, HappyView/PDS/AppView API calls, blob downloads/proxying, target-record reads, target previews, recursive/detail hydration, activity-label hydration, preference persistence, or migrations/indexes. Service-auth verification is limited to the maintained AT Protocol verifier and the bounded DID-resolution boundary described above; retain only bounded, process-local replay-protection state through the JWT `jti`, and never log authorization credentials, JWTs, or claims.

## Change checklist

1. Inspect branch and working tree; preserve unrelated or in-flight changes.
2. Change only the owning layer and coupled contracts.
3. Add focused tests. SQL behavior requires PostgreSQL integration coverage.
4. Update Lexicons and documentation for public behavior changes.
5. Add a Changeset when the change has release impact under the release workflow policy.
6. Run `npm run check`, `npm test`, `npm run build`, and `git diff --check`.
7. Run integration tests only with an explicitly selected disposable PostgreSQL database.
8. Report commands, failures, and unavailable validation.
