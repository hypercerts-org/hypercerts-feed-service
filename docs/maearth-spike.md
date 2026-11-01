# MaEarth Following feed spike

Experimental implementation of the October 14, 2026 MaEarth feed scope. This is a feasibility spike, not a production rollout or a claim of parity with MaEarth's application database.

The feed is **off by default**. Set `MAEARTH_FEED_ENABLED=true` to register it. When it is `false`, unset or empty, the `feedId` is unregistered and a well-formed request returns `UnsupportedFeed` (a malformed one, such as an anonymous request without `viewerDid`, is still rejected earlier as `InvalidRequest`); a value other than `true` or `false` fails startup with an actionable error. HappyView must have the `org.hypercerts.context.attachment`, `app.certified.graph.follow`, `app.certified.graph.entityFollow`, `app.certified.feed.repost` and `org.hypercerts.collection` lexicons installed, subscribed and backfilled; otherwise those kinds silently return nothing and `GET /ready` will not say so (see [database-contract.md](database-contract.md#experimental-maearth-selection)).

## Contract

Both procedures accept `feedId: org.hypercerts.feed.defs#maearthFeed` and params with `$type: org.hypercerts.feed.defs#maearthFeedParams`:

- `viewerDid`: required anonymously; a verified service-auth issuer supplies it when authenticated. A conflicting body DID is rejected.
- `kinds`: optional array of `post`, `projectFollow`, `accountFollow`, `repost`. Omitted or empty means all four. Account follows deliberately do not distinguish organizations from people; MaEarth owns that mapping.
- `actorDid`: optional restriction **within the viewer's existing Following scope**, not an unrestricted profile feed.
- Top-level `limit`: default 20, maximum 50. `cursor` is opaque and scoped to this feed.
- Errors follow the Hypercerts feed: structurally invalid params (such as a malformed `viewerDid` or `actorDid`) return HTTP 400, and semantic errors (an unsupported `kinds` value, `limit` outside 1–50, or a missing `viewerDid`) return HTTP 422, both as `InvalidRequest`.

`getFeedSkeleton` stays URI-only. `getFeed` returns merge metadata in a new open view variant:

```json
{
  "feed": [
    {
      "subject": "at://did:plc:dddddddddddddddddddddddd/app.certified.feed.repost/3jzfcijpj2zd",
      "view": {
        "$type": "org.hypercerts.feed.defs#maearthFeedView",
        "kind": "repost",
        "createdAt": "2026-10-14T12:00:00.123456Z",
        "repostedPostUri": "at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.context.attachment/original"
      }
    },
    {
      "subject": "at://did:plc:cccccccccccccccccccccccc/app.certified.graph.entityFollow/3jzfcijpj2ze",
      "view": {
        "$type": "org.hypercerts.feed.defs#maearthFeedView",
        "kind": "projectFollow",
        "createdAt": "2026-10-14T11:59:00.000000Z",
        "followedProjectUri": "at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.collection/project"
      }
    },
    {
      "subject": "at://did:plc:cccccccccccccccccccccccc/app.certified.graph.follow/3jzfcijpj2zf",
      "view": {
        "$type": "org.hypercerts.feed.defs#maearthFeedView",
        "kind": "accountFollow",
        "createdAt": "2026-10-14T11:58:00.000000Z",
        "followedDid": "did:plc:dddddddddddddddddddddddd"
      }
    }
  ]
}
```

`subject` identifies the item's own record, not its target. `createdAt` is the **effective sort timestamp** (validated source `createdAt`, otherwise valid HappyView `indexed_at`), normalized to UTC with microseconds. It is not necessarily the literal source field. Repost targets are not fetched, and their existence is not required. MaEarth can drop invisible entries, but must keep advancing the returned cursor, even for an empty visible page.

**Follow targets.** A `projectFollow` carries `followedProjectUri`, the followed `org.hypercerts.collection` URI that resolved to a `type` of `project`. An `accountFollow` carries `followedDid`, the DID in the follow record's subject. Each is absent for every other kind, and no kind carries a follower field: the follower is the authority of the item's `subject` URI. Both values come from the same statement and the same records already read to select the item, so they add no query or read. They are not cross-checked against the requester: a stranger's follow of a followed account names that followed account, and a followed account's follow names whomever it followed. The skeleton does not carry them. The fields are optional additions to the open view, so existing consumers are unaffected.

### Selection

The full current graph is resolved in SQL without the previous 500-account cap or per-DID calls:

| Kind            | Selection                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `post`          | Update attachments authored by a directly followed account, the viewer, or whose `subjects[].uri` matches a followed project (see below).                                                                                                                                                        |
| `projectFollow` | Direct entity follows with a `app.certified.defs#recordSubject` URI that resolves to a project, authored by a followed account or targeting a followed project.                                                                                                                                  |
| `accountFollow` | Direct Certified follows, authored by a followed account or targeting a followed account.                                                                                                                                                                                                        |
| `repost`        | Reposts by followed accounts targeting a valid attachment URI with a nonempty CID. Reposts of other collections, and targets that are not valid AT-URIs (a record key of `.`, `..` or over 512 characters, or an authority DID over 2048 characters), are excluded rather than failing the page. |

**Direct follows only.** `via` must be absent or JSON `null` on both `app.certified.graph.follow` and `app.certified.graph.entityFollow`, in the viewer's scope and in every returned follow item. A mediated follow (non-null `via`) neither widens the viewer's scope nor appears as an item. The same rule applies to account follows and entity follows.

**Projects.** A followed target counts only when, in the same statement, its URI resolves to a current `org.hypercerts.collection` row whose guarded-parsed JSON `type` is `'project'`. A favorites, portfolio or program collection, a collection with no `type`, an unparseable record, and a URI with no stored collection record are all excluded. The same check applies to the target of every `projectFollow` item, including those authored by followed accounts. The collection record's own `$type` is not checked.

**Posts about projects.** A post is about a followed project when any `subjects[].uri` equals either the followed project's collection URI, or an `org.hypercerts.claim.activity` URI listed in that collection's current `items[].itemIdentifier.uri`. Production update attachments can reference only the project's activity, so both are matched. Matching is by URI, never CID. Activities are read from the collection record itself in the same statement; activity records are not read, and items that are not `org.hypercerts.claim.activity` URIs (nested collections, features) are not matched. The set is derived once per request from the viewer's followed projects only; an unfollowed project's items and a followed non-project collection's items never match.

The viewer's own graph edges can appear because their targets are followed. The viewer's own reposts are not implicitly included. Project identity matches the URI, not a CID.

**Effective timestamp.** The validated source `createdAt`, otherwise valid `indexed_at`, normalized to UTC with microseconds. Every returned value lies within `0001-01-01T00:00:00Z` through `9999-12-31T23:59:59.999999Z`. A `createdAt` that is unparseable or malformed, or that falls before year 1 in UTC (for example `0001-01-01T00:00:00+05:00`), falls back to a valid `indexed_at` from year 1 onward; if `indexed_at` is also before year 1 or invalid, the row is excluded. A `createdAt` that parses as a real timestamp beyond year 9999 in UTC (for example `9999-12-31T23:59:59-01:00`) does not fall back: it is future-dated and hidden (next paragraph). The year-1 floor and the future cutoff keep every returned `createdAt` a valid atproto datetime and every cursor value round-trippable.

**Future-dated items are hidden.** A row whose effective timestamp is later than the database's statement time plus five minutes is dropped, whatever its kind, and whether it was author-driven or target-driven. The cutoff uses PostgreSQL's `statement_timestamp()` (one reading per statement) and a single named skew constant in `src/feed/maearth-query.sql`. Any `createdAt` that parses as a real future timestamp (2099, `9999-12-31T23:59:59Z`, or a value that lands beyond year 9999 after its offset) is excluded, **not** replaced by `indexed_at`; only an unparseable `createdAt`, or one before year 1, falls back, as above. An item whose only valid timestamp is a future `indexed_at` is also hidden. Hidden items are removed before the page limit is applied, so they never shorten a page or move the cursor. Because the cutoff moves with the clock, an item dated slightly in the future becomes visible once its time arrives, but only on a traversal that has not already paged past its position.

One parameterized statement handles scope, selection and pagination for either endpoint. Sort order is effective timestamp descending, URI descending. MaEarth views require no profile query, source-body hydration, repost-target or post-subject reads, API calls, or backfilling of dropped items. The only records read beyond the selected ones are the followed-project `org.hypercerts.collection` records that resolve scope, in the same statement. Hypercerts selection and its existing view remain unchanged.

### Query shape and performance

`src/feed/maearth-query.sql` resolves everything in one statement. Its shape is intended to avoid whole-collection JSON decoding where possible:

- The viewer's own follow and entity-follow records are read by `did` and decoded; the followed accounts and projects are `DISTINCT` and materialized with no cap. Followed projects resolve by exact-URI primary-key lookups.
- **Author-driven rows** (the viewer's and followed accounts' posts, follows, entity follows and reposts) are read with one `(did, collection)` probe per account and selected collection, and only those candidates are JSON-decoded, once. **That still means every selected-collection record of every followed account is read and decoded on every page:** the effective timestamp comes from the decoded JSON, so keyset pagination cannot skip rows before decoding. Per-page cost scales with the followed accounts' total history, not with the page size.
- **Target-driven rows** (other accounts' follows of followed accounts or projects, and other accounts' posts about followed projects) cannot be found by author. They are found by scanning the selected collection, decoding each record once behind a `MATERIALIZED` CTE, and keeping only rows that hit a followed target and are not already author-driven. **These branches still scan every record in their collections on every request.** Attachments can be large. They are skipped entirely when the corresponding target set is empty, and for any kind that the `kinds` filter excludes.
- The `kinds` filter is applied before any record is read: a single-kind request reads only that kind's collection (plus the viewer's graph and project lookups).
- Authored follow items must also resolve their project target, by one primary-key lookup per candidate.

The planner decides the physical plan. This spike has **no `EXPLAIN (ANALYZE, BUFFERS)` evidence on production-shaped data**, so no latency or capacity claim is made. Before any shared deployment, capture it against a copy with production-like row counts, large attachments, and the deployment's own `jit` setting. A local synthetic check suggests the estimated cost of this statement can exceed PostgreSQL's default `jit_above_cost`, in which case JIT compilation, not row processing, can dominate; confirm and, if needed, disable JIT for the feed's read-only role. The service never creates indexes: if the target-driven scans prove too costly, the follow-up is a HappyView-owned index or projection (for example by follow subject or by attachment subject), not a change here.

### Known limitations

- **Author-controlled timestamps within the skew.** Far-future items can no longer pin themselves to the top, but an item may still claim any time up to five minutes ahead of the database clock, and a backdated `createdAt` sorts wherever its author says. MaEarth merges by `createdAt`, so such an item can briefly float above its own gifts. Target-driven rows keep this open to any account that follows a followed account or project, or posts about a followed project. (Any account can likewise place a post about any project into its followers' feeds; MaEarth's own visibility filtering is the control.) Only the database clock is read. The five-minute skew assumes it is reasonably accurate; a database clock running more than that behind its writers would hide valid items.
- **The Hypercerts feed still has the far-future exposure.** `src/feed/feed-query.sql` accepts any valid in-range `createdAt`, including 2099, so a far-future item pins to the top of that feed until removed. This change does not touch it. Follow-up: decide whether the Hypercerts feed should adopt the same cutoff, which would change its public ordering semantics and its tests.
- `actorDid` only narrows the viewer's Following scope; it cannot serve a public profile page for someone the viewer does not follow.

## Local Docker validation

Prerequisites: Docker Compose, local npm dependencies, and a read-only `../hypercerts-api` checkout with its pinned dependencies installed. **Both the feed tree and the API tree must be clean** (no uncommitted or untracked changes), because the recorded HEAD SHAs are only meaningful when they describe the content that was built and mounted; commit or stash local feed changes before a provenance run. The harness mounts the API checkout read-only and uses its actual `api/manifest.json` and maintained `install:api` CLI; it installs every declared Lexicon and Lua script, not just record schemas. The installer runs only against this fresh disposable HappyView instance and **does not publish schemas to ATProto**. Record ingestion is real HappyView validation and persistence over a local mock Jetstream, not direct SQL inserts. The feed container is started with `MAEARTH_FEED_ENABLED=true`. The evidence records both HEAD SHAs and, independently of Git, the SHA-256 of the mounted `api/manifest.json`.

Run from this repository:

```sh
test -z "$(git status --porcelain)" ||
  { echo 'Feed tree is not clean; commit or stash first' >&2; exit 1; }
test -z "$(git -C ../hypercerts-api status --porcelain)" ||
  { echo 'API tree is not clean; use a clean checkout' >&2; exit 1; }
export SPIKE_DIR=$(mktemp -d /tmp/maearth-full-api.XXXXXX)
export COMPOSE_PROJECT_NAME=maearth-full-api-$(date +%s)-$$
export HYPERCERTS_API_DIR=$(realpath ../hypercerts-api)
export SPIKE_API_SHA=$(git -C "$HYPERCERTS_API_DIR" rev-parse HEAD)
export SPIKE_FEED_SHA=$(git rev-parse HEAD)
node scripts/maearth-spike/prepare-env.mjs "$SPIKE_DIR/stack.env"
dc() {
  docker compose --env-file "$SPIKE_DIR/stack.env" \
    -p "$COMPOSE_PROJECT_NAME" -f scripts/maearth-spike/compose.yaml "$@"
}
dc up -d --build
dc exec -T validation node scripts/maearth-spike/validate.mjs
dc exec -T validation ./node_modules/.bin/vitest run test/maearth.integration.test.ts
docker cp "$(dc ps -q validation):/tmp/maearth-evidence.json" "$SPIKE_DIR/evidence.json"
docker cp "$(dc ps -q validation):/tmp/maearth-install-installer.stdout.json" "$SPIKE_DIR/installer-install.json"
docker cp "$(dc ps -q validation):/tmp/maearth-install-installer.stderr.log" "$SPIKE_DIR/installer-install.log"
docker cp "$(dc ps -q validation):/tmp/maearth-readback-installer.stdout.json" "$SPIKE_DIR/installer-readback.json"
docker cp "$(dc ps -q validation):/tmp/maearth-readback-installer.stderr.log" "$SPIKE_DIR/installer-readback.log"
dc port gateway 3000
```

`validate.mjs` refuses a nonempty record database. Run it once per fresh project. It creates a disposable installer user (a HappyView super user, which owns the key) and an API key limited to the API installer's required permissions, plus a separate SELECT-only feed login with read-only sessions. Only `PATH` and the installer's own variables are passed to the third-party installer process; stack credentials are not. The validation container shares HappyView's network namespace so the maintained installer's loopback-only HTTP policy can use `http://localhost:3000`; it invokes the CLI to install the entire bundle and then read back every declared asset. Evidence includes manifest counts and asset IDs, the API manifest SHA-256, installer output, source SHAs, schema inspection, ingested record CIDs, executed API endpoints, and feed assertions; it contains no stack credentials. HappyView itself applies its migrations. The installer creates the handle-resolver setting, but the endpoint checks do not invoke handle lookup. The feed may initially report not-ready until setup creates its login. Do not point these helpers at an existing HappyView installation.

The PostgreSQL data directory is tmpfs, not durable. HappyView, PostgreSQL, feed, mocks and validation runner use an internal network without Internet egress. The validation container shares HappyView's network namespace; a separate TCP gateway publishes only the feed on a random **loopback** port. Admin/database/mock published-port declarations are not reachable on Docker Desktop's internal network; use container exec. The gateway has a second bridge network for host access. No remote relay, PDS, DID resolver or labeler is contacted by the validation checks. Image pulls and npm installation happen during builds, before runtime network isolation.

After `dc port gateway 3000`, substitute that port below:

```sh
curl -sS http://127.0.0.1:PORT/xrpc/org.hypercerts.feed.getFeed \
  -H 'content-type: application/json' \
  -d '{"feedId":"org.hypercerts.feed.defs#maearthFeed","params":{"$type":"org.hypercerts.feed.defs#maearthFeedParams","viewerDid":"did:plc:cccccccccccccccccccccccc"},"limit":2}'
```

The validator checks 18 real ingested source records (including a project-type collection, a favorites-type collection, an activity-only post, and entity follows of a favorites collection and of a never-stored collection), confirms each stored CID equals the validator-computed CID it sent, then executes installed API Lua endpoints `app.certified.graph.getFollows`, `app.certified.graph.getEntityFollows`, `org.hypercerts.context.getAttachment`, `org.hypercerts.context.listAttachments`, and `app.certified.feed.getReposts` against those same records. It also checks both feed endpoints, all four MaEarth kinds, matching skeleton/view cursors, pagination, actor/kind filters, and update/delete/unfollow effects across API and feed responses. It restores the demonstration records after mutation checks. The focused MaEarth PostgreSQL suite uses a session-local temporary table for malformed JSON/timestamps, fallback ordering, timestamp bounds, feed-scoped cursors, project resolution, mediated follows, and a 505-account graph; those SQL fixtures are not claimed as valid ingested records. `validate.mjs` also asserts the follow targets on every ingested follow item and their absence on posts and reposts. The harness has not been re-run since the project-resolution fixtures or the follow-target assertions were added; treat its updated expectations as unverified until it is. Its fixtures use a past `createdAt`, so the future-dated cutoff does not affect it.

The harness leaves its containers and evidence available for inspection. When explicitly choosing to discard the disposable data, `dc down` removes only that project; do not use global Docker cleanup commands. Keep `$SPIKE_DIR/stack.env` until teardown, and do not commit it.

## Not covered

- Gifts, donation rollups, For you discovery/fallback, funding rounds and unrestricted public profile feeds.
- MaEarth privacy, mutes, hidden posts, public-profile eligibility for reposts, announcements, organization/person distinctions, and attachment-to-project mapping. These require MaEarth's database; inclusion here does not imply visibility there.
- Reaction counts, viewer reactions, follower totals or Follow-button state.
- Production scale or latency guarantees. The 505-account check proves no truncation, not performance.
- Live PDS-issued JWTs and public DID resolution. Viewer binding is unit-tested; local HTTP validation is anonymous.
- Labels and moderation ingestion. MaEarth selection does not consume organization quality labels.
- A single cursor merging gifts with ATProto records: MaEarth still owns that merge and needs its own composite pagination strategy. Returning timestamps alone does not solve cross-source pagination.

## Open questions and before production

Open questions for MaEarth and the feed owners:

- Whether the skeleton may also carry `createdAt`, instead of MaEarth calling `getFeed` for merge metadata. The spike answers by keeping the skeleton URI-only.
- Whether `actorDid` must serve unrestricted profile pages.

Resolved:

- MaEarth projects are `org.hypercerts.collection` records with `type` `'project'`; matching a followed project's collection URI or the activity URIs in its `items[]` is sufficient (see Selection).
- Follow items name their target through `followedProjectUri` and `followedDid`, so MaEarth needs no per-item record lookup (see Contract).
- Far-future `createdAt` values are hidden by a five-minute skew cutoff (see Selection).

Before production: agree on the public schema, confirm actual MaEarth record shapes, test a privacy-aware consumer and gift-merge pagination, confirm HappyView has all five lexicons installed, subscribed and backfilled, and measure SQL plans on production-shaped data (see Query shape and performance). The feed is read-only and does not own migrations or indexes.
