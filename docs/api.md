# API reference

Both feed procedures are POST endpoints with an optional AT Protocol service-auth `Authorization` header:

```text
POST /xrpc/org.hypercerts.feed.getFeedSkeleton
POST /xrpc/org.hypercerts.feed.getFeed
Content-Type: application/json
```

These are app-specific XRPC procedures. They are not Bluesky's `app.bsky.feed.getFeedSkeleton` query.

The procedure and JSON-body design is intentional. A Lexicon query cannot have an input body, and Lexicon's HTTP query-parameter `params` type cannot contain references, nested objects, or the open union needed for different feed algorithms to define different parameter shapes. Procedures can have both URL parameters and a body, but splitting `feedId`, `limit`, and `cursor` into the URL while putting algorithm-specific values in the body would make one feed request harder to construct and understand. Keeping the complete request in one JSON body conforms to the Lexicon specification and gives generated clients one coherent input object. It differs only from the style guide's usual `limit` and `cursor` convention for query endpoints. This transport shape is part of the public contract and should be settled before clients adopt it, because moving fields between the body and URL later would be a breaking change.

## Request wrapper

Both feed endpoints are POST procedures with optional AT Protocol service authentication. They use the same `{ feedId, params?, limit?, cursor? }` request wrapper, feed-scoped cursor contract, and stable public errors. `params` contains only algorithm-specific values; pagination is generic and top-level. The registered Hypercerts feed requires the Hypercerts params object and discriminator. Anonymous requests must include `params.viewerDid`; authenticated callers may omit it, and the verified JWT issuer supplies the viewer. A supplied viewer DID must match the issuer.

Use the same body with `getFeedSkeleton` when another data system needs only ordered source AT-URIs. A service caller may add `-H 'authorization: Bearer <service-auth-jwt>'` and omit `viewerDid`; the token must target the bare DID configured as `SERVICE_DID`, carry the exact endpoint NSID in `lxm`, and be signed by the issuer's `#atproto` key. Invalid supplied authorization returns 401 and is never treated as anonymous. The public params union is open for future feed algorithms, including algorithms that accept no params. The Hypercerts feed requires `org.hypercerts.feed.defs#hypercertsFeedParams`; the experimental MaEarth feed, when enabled, requires `org.hypercerts.feed.defs#maearthFeedParams`; missing params or a mismatched `$type` returns `InvalidRequest`, while an unknown `feedId` returns `UnsupportedFeed`.

## Responses

### Skeleton

```json
{
  "feed": [
    {
      "subject": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.claim.activity/3kpn"
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjoxLCJmZWVkSWQiOiJvcmcuaHlwZXJjZXJ0cy5mZWVkLmRlZnMjaHlwZXJjZXJ0c0ZlZWQiLCJ2YWx1ZSI6eyJ2YWx1ZSI6IjIwMjYtMDctMjFUMTA6MDA6MDAuMDAwMDAwWiIsInVyaSI6ImF0Oi8vZGlkOnBsYzpld3ZpN254enlvdW42emh4cmhzNjRvaXovb3JnLmh5cGVyY2VydHMuY2xhaW0uYWN0aXZpdHkvM2twbiJ9fQ"
}
```

Each skeleton entry intentionally contains only the source record AT-URI. A downstream hydrator resolves the current indexed record version; the skeleton does not pin hydration to a CID or expose feed-specific classification metadata. Send a returned cursor back as the top-level request `cursor`, never inside algorithm-specific `params`.

### Hydrated (Hypercerts feed)

```json
{
  "feed": [
    {
      "subject": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.context.evaluation/3kpn",
      "view": {
        "$type": "org.hypercerts.feed.defs#hypercertsFeedView",
        "kind": "evaluation.create",
        "actor": {
          "did": "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
          "displayName": "Evaluator"
        },
        "content": {
          "$type": "org.hypercerts.feed.defs#evaluationView",
          "summary": "Strong evidence",
          "createdAt": "2026-07-21T10:00:00.000Z",
          "target": {
            "uri": "at://did:plc:ar7c4by46qjdydhdevvrndac/org.hypercerts.claim.activity/target",
            "cid": "bafyreifxcn6ts5hr6oequ5w5jyrpwrdl6p5lq46jasnxmcw3h3sme6asru"
          }
        }
      }
    }
  ]
}
```

Every hydrated entry has a generic source `subject` and an open `view` union. The current `hypercertsFeedView` variant owns the Hypercerts event kind, actor, and kind-specific content. Clients must tolerate unknown future feed-view and content variants.

### What you get (Hypercerts feed)

These guarantees apply to the Hypercerts feed. MaEarth entries carry metadata only, with no `actor` or `content`, and skip source hydration; see the MaEarth section below.

Every hydrated feed entry comes from a valid source record. Each entry has a feed-specific view and kind-specific content.

The service uses a meaningful, valid Certified profile for an actor's display name and avatar. If no such profile is available, the actor is represented by their DID. It does not expose stored handles or fall back to Bluesky profiles.

An evaluation, measurement, or update may point to another record by its exact URI and CID. These targets remain strong references even though the entry's source `subject` is URI-only. The service checks that each target reference is valid.

Clients must accept image and feed formats they do not know. Known images keep their original Hypercerts and AT Protocol formats.

### What the service does not do (Hypercerts feed)

The service removes invalid feed items and does not replace them. A page may therefore have fewer items than requested, or no items. The cursor still advances past every record the service checked.

The response never contains the original source JSON. It also does not say where actor details came from.

The service does not fetch, preview, or expand linked records. It only checks that the link contains a valid URI and CID.

The service does not contact a PDS, AppView, or HappyView API. It does not download or proxy image files.

## Request behavior and errors

- Malformed JSON, missing required params, anonymous requests without `params.viewerDid`, an authenticated supplied viewer mismatch, an invalid nested `viewerDid`, params that do not match the selected feed, or structurally invalid top-level pagination return HTTP 400 with `InvalidRequest`. Semantically invalid selected-feed parameters or pagination beyond that feed's supported range return HTTP 422 with the same generic error name and an actionable message. An unregistered `feedId` returns `UnsupportedFeed`. These never become internal server errors.
- A present `Authorization` header is always verified. Malformed, expired, not-yet-valid, wrong-audience, wrong-endpoint, unresolved-issuer, or incorrectly signed service JWTs return HTTP 401; the request is never retried anonymously. DID documents are resolved over bounded HTTPS-only requests with direct public-address pinning; `did:web` redirects and private, loopback, link-local, reserved, and special-use destinations are rejected.
- Service-auth JWTs must include a signed, non-empty `jti` no larger than 256 UTF-8 bytes. After signature, audience, expiry, and exact endpoint checks succeed, the service accepts each issuer-and-`jti` pair once. A token is consumed before the downstream feed request runs, so retries require a fresh token even when feed generation fails. Replay state is bounded to 512 live entries per verified issuer and 4,096 live entries total, local to the running process, cleared on restart, and not shared between replicas; a full live issuer quota or global store returns HTTP 503 until entries expire. Anonymous requests remain unaffected because they do not use service-auth replay state.

**Accepted pre-launch risk:** Eight verified issuers can each consume 512 live entries and fill the 4,096-entry process-wide store. While it is full, fresh valid tokens from unrelated issuers receive HTTP 503 until entries expire. The per-issuer cap does not prevent this cross-issuer denial of authenticated requests. Keep one-use tokens and fail-closed behavior for now; revisit capacity and abuse controls before relying on authenticated feed availability.

Stable public feed errors:

```text
InvalidRequest
UnsupportedFeed
InvalidCursor
InternalError
```

Feed-specific parameter failures use `InvalidRequest`; their message identifies the invalid parameter and how to correct it.

Public errors never show SQL, database credentials, table contents, internal causes, or stack traces.

## Hypercerts feed selection

- The base scope always comes from the viewer's current `app.certified.graph.follow` records. The service ignores malformed follow subjects.
- `trustedEvaluators` adds the subjects of every current, active endorsement award from each evaluator.
- An endorsement definition with no `allowedIssuers` allows any issuer. When it is present, only its listed issuer DIDs qualify. An empty or malformed value allows no issuers.
- The service removes the viewer. It does not query actor status; only the current follow, award, and feed records present in HappyView affect selection.
- `params.organizationQuality` sets the quality policy: `{ "allowed": [...], "includeUnrated": true | false }`, both required. `allowed` takes up to 8 labels; known values are `high-quality`, `standard`, `draft` and `likely-test`. `includeUnrated` decides whether organizations with no active trusted label qualify. Omit the object to apply no quality filter.
- The organization-quality rules run against the final combined author list before event selection. Only exact `app.certified.actor.organization/self` records count as organizations.
- Trusted quality labelers come only from the service configuration. Quality labels are current positive `happyview_labels` rows matched to a bare organization DID. `cts` and `exp` are stored as TEXT and must be complete, finite RFC3339 or legacy PostgreSQL timestamp values; `cts` is validated but not used for ordering, and `exp` is validated before casting. Malformed, date-only, nonfinite, or elapsed values are inactive. HappyView removes a matching row when it receives a negation, and the table has no label CID or history. A row proves only that HappyView currently projects that label, not that every label was ingested. Callers cannot choose label sources.
- Leaving out `kinds`, or passing an empty list, includes every supported kind. Unknown kinds are rejected as `InvalidRequest`.

Supported event kinds:

```text
cert.create
collection.create
project.created_with_cert
evaluation.create
measurement.create
update.create
endorsement.award
```

Project and activity records are combined before kind filtering and pagination. After a collection is returned as `project.created_with_cert`, its paired activity cannot appear on a later page.

## Ordering and pagination

The order is:

```text
feed timestamp DESC, record URI DESC
```

Entries appear newest first using an internal feed timestamp. HappyView stores record JSON and `indexed_at` as TEXT; the query validates JSON and timestamp text before casting, falls back from an invalid or absent `createdAt` to a finite, complete `indexed_at` in RFC3339 or legacy PostgreSQL format, and compares timestamps chronologically rather than lexically. Date-only and nonfinite fallback values are rejected. HappyView's `created_at` is row-ingestion time and is not used for feed ordering. Invalid source JSON does not abort selection; hydration drops an invalid selected source without backfilling. The Hypercerts feed does not expose its effective timestamp in either response; the experimental MaEarth feed returns its effective sort timestamp as `createdAt` in its `getFeed` view only, bounded to years 0001 through 9999 UTC, and hides rows dated more than five minutes after the database's statement time; the Hypercerts feed applies no such cutoff. Pagination moves forward from the last source row chosen before hydration, so removing an invalid hydrated entry does not move the cursor.

### Pages and database reads

**Pages**

- The service checks one extra item to see whether another page exists.
- The cursor marks the last item selected and is valid only for the `feedId` that issued it.
- Both endpoints use the same top-level pagination, ordering, and feed-scoped cursor rules.
- Invalid hydrated entries are removed, not replaced.

**Database work**

- A skeleton page uses one database query.
- A Hypercerts `getFeed` page also loads actor and profile details when it has valid entries. MaEarth pages load no profiles.
- The service never makes extra queries to fill gaps left by invalid entries.

**Freshness**

Feed entries and their source records are read together. Actor and profile details are loaded afterward, so they may be newer.

Each page is a separate database read. Changes made between requests may appear on later pages.

**Record size**

A page query returns at most 51 source records (the limit plus one). This bounds the result, not the rows the database reads to produce it: MaEarth, for example, can scan and decode whole collections before pagination (see Query shape and performance). Returned record size is not limited, so unusually large records may take longer and use more memory.

Source JSON is never returned.

## MaEarth Following feed (experimental)

The feed is **off by default**. Set `MAEARTH_FEED_ENABLED=true` to register it. When it is `false`, unset or empty, the `feedId` is unregistered and a well-formed request returns `UnsupportedFeed` (a malformed one, such as an anonymous request without `viewerDid`, is still rejected earlier as `InvalidRequest`); a value other than `true` or `false` fails startup with an actionable error. HappyView must have the `org.hypercerts.context.attachment`, `app.certified.graph.follow`, `app.certified.graph.entityFollow`, `app.certified.feed.repost` and `org.hypercerts.collection` lexicons installed, subscribed and backfilled; otherwise those kinds silently return nothing and `GET /ready` will not say so (see [database-contract.md](database-contract.md#experimental-maearth-selection)).

### Contract

Both procedures accept `feedId: org.hypercerts.feed.defs#maearthFeed` and params with `$type: org.hypercerts.feed.defs#maearthFeedParams`:

- `viewerDid`: required anonymously; a verified service-auth issuer supplies it when authenticated. A conflicting body DID is rejected.
- `kinds`: optional array of `post`, `projectFollow`, `accountFollow`, `repost`. Omitted or empty means all four. Account follows deliberately do not distinguish organizations from people; MaEarth owns that mapping.
- `actorDid`: optional author restriction applied to the viewer's Following selection. The actor's own posts, follows and reposts appear when the actor is followed; a non-followed actor appears only through target-driven rows (their posts about a followed project, or their follows of a followed project or account). It is not an unrestricted profile feed.
- Top-level `limit`: default 20, maximum 50. `cursor` is opaque and scoped to this feed.
- Errors follow the Hypercerts feed: structurally invalid params (such as a malformed `viewerDid` or `actorDid`) and anonymous requests without `viewerDid` return HTTP 400; semantic errors (an unsupported `kinds` value or `limit` outside 1–50) return HTTP 422. Both use `InvalidRequest`.

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
        "cid": "bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u",
        "actorDid": "did:plc:dddddddddddddddddddddddd",
        "repostedPostUri": "at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.context.attachment/original"
      }
    },
    {
      "subject": "at://did:plc:cccccccccccccccccccccccc/app.certified.graph.entityFollow/3jzfcijpj2ze",
      "view": {
        "$type": "org.hypercerts.feed.defs#maearthFeedView",
        "kind": "projectFollow",
        "createdAt": "2026-10-14T11:59:00.000000Z",
        "cid": "bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u",
        "actorDid": "did:plc:cccccccccccccccccccccccc",
        "followedProjectUri": "at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.collection/project"
      }
    },
    {
      "subject": "at://did:plc:cccccccccccccccccccccccc/app.certified.graph.follow/3jzfcijpj2zf",
      "view": {
        "$type": "org.hypercerts.feed.defs#maearthFeedView",
        "kind": "accountFollow",
        "createdAt": "2026-10-14T11:58:00.000000Z",
        "cid": "bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u",
        "actorDid": "did:plc:cccccccccccccccccccccccc",
        "followedDid": "did:plc:dddddddddddddddddddddddd"
      }
    }
  ]
}
```

`subject` identifies the item's own record, not its target. `createdAt` is the **effective sort timestamp** (validated source `createdAt`, otherwise valid HappyView `indexed_at`), normalized to UTC with microseconds. It is not necessarily the literal source field. Repost targets are not fetched, and their existence is not required. MaEarth can drop invisible entries, but must keep advancing the returned cursor, even for an empty visible page.

**Record identity.** Every item carries `cid`, the CID of its own record (the `subject`), and `actorDid`, the record's author: the poster, follower or reposter, which is always the authority of `subject`. Both come from the record row the statement already selected, so they add no query or read.

**Follow targets.** A `projectFollow` carries `followedProjectUri`, the followed `org.hypercerts.collection` URI that resolved to a `type` of `project`. An `accountFollow` carries `followedDid`, the DID in the follow record's subject. Each is absent for every other kind, and the follower is the item's `actorDid`, the authority of its `subject` URI. Both values come from the same statement and the same records already read to select the item, so they add no query or read. They are not cross-checked against the requester: a stranger's follow of a followed account names that followed account, and a followed account's follow names whomever it followed. The skeleton does not carry them. The fields are optional additions to the open view, so existing consumers are unaffected.

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

One parameterized statement handles scope, selection and pagination for either endpoint. Sort order is effective timestamp descending, URI descending. MaEarth views require no profile query, source-body hydration, repost-target or post-subject reads, API calls, or backfilling of dropped items. The only records read beyond the selected ones are `org.hypercerts.collection` records looked up by primary key in the same statement: the viewer's followed projects (to resolve scope) and the collections named by followed accounts' entity follows (to check they are projects). Hypercerts selection and its existing view remain unchanged.

### Query shape and performance

`src/feed/maearth-query.sql` resolves everything in one statement. Its shape is intended to avoid whole-collection JSON decoding where possible:

- The viewer's own follow and entity-follow records are read by `did` and decoded; the followed accounts and projects are `DISTINCT` and materialized with no cap. Followed projects resolve by exact-URI primary-key lookups.
- **Author-driven rows** (the viewer's and followed accounts' posts, follows, entity follows and reposts) are read with one `(did, collection)` probe per account and selected collection, and only those candidates are JSON-decoded, once. **That still means every selected-collection record of every followed account is read and decoded on every page:** the effective timestamp comes from the decoded JSON, so keyset pagination cannot skip rows before decoding. Per-page cost scales with the followed accounts' total history, not with the page size.
- **Target-driven rows** (other accounts' follows of followed accounts or projects, and other accounts' posts about followed projects) cannot be found by author. They are found by scanning the selected collection, decoding each record once behind a `MATERIALIZED` CTE, and keeping only rows that hit a followed target and are not already author-driven. **These branches still scan every record in their collections on every request.** Attachments can be large. They are skipped entirely when the corresponding target set is empty, and for any kind that the `kinds` filter excludes.
- The `kinds` filter is applied before any record is read: a single-kind request reads only that kind's collection (plus the viewer's graph and project lookups).
- Authored follow items must also resolve their project target, by one primary-key lookup per candidate.

The planner decides the physical plan. There is **no `EXPLAIN (ANALYZE, BUFFERS)` evidence on production-shaped data**, so no latency or capacity claim is made. Before any shared deployment, capture it against a copy with production-like row counts, large attachments, and the deployment's own `jit` setting. A local synthetic check suggests the estimated cost of this statement can exceed PostgreSQL's default `jit_above_cost`, in which case JIT compilation, not row processing, can dominate; confirm and, if needed, disable JIT for the feed's read-only role. The service never creates indexes: if the target-driven scans prove too costly, the follow-up is a HappyView-owned index or projection (for example by follow subject or by attachment subject), not a change here.

### Known limitations

- **Author-controlled timestamps within the skew.** Far-future items can no longer pin themselves to the top, but an item may still claim any time up to five minutes ahead of the database clock, and a backdated `createdAt` sorts wherever its author says. MaEarth merges by `createdAt`, so such an item can briefly float above its own gifts. Target-driven rows keep this open to any account that follows a followed account or project, or posts about a followed project. (Any account can likewise place a post about any project into its followers' feeds; MaEarth's own visibility filtering is the control.) Only the database clock is read. The five-minute skew assumes it is reasonably accurate; a database clock running more than that behind its writers would hide valid items.
- **The Hypercerts feed still has the far-future exposure.** `src/feed/feed-query.sql` accepts any valid in-range `createdAt`, including 2099, so a far-future item pins to the top of that feed until removed. Open question: decide whether the Hypercerts feed should adopt the same cutoff, which would change its public ordering semantics and its tests.
- `actorDid` only narrows the viewer's Following scope; it cannot serve a public profile page for someone the viewer does not follow.

### Not covered

- Gifts, donation rollups, For you discovery/fallback, funding rounds and unrestricted public profile feeds.
- MaEarth privacy, mutes, hidden posts, public-profile eligibility for reposts, announcements, organization/person distinctions, and attachment-to-project mapping. These require MaEarth's database; inclusion here does not imply visibility there.
- Reaction counts, viewer reactions, follower totals or Follow-button state.
- Production scale or latency guarantees. The 505-account check proves no truncation, not performance.
- Live PDS-issued JWTs and public DID resolution. Viewer binding is unit-tested only.
- Labels and moderation ingestion. MaEarth selection does not consume organization quality labels.
- A single cursor merging gifts with ATProto records: MaEarth still owns that merge and needs its own composite pagination strategy. Returning timestamps alone does not solve cross-source pagination.
