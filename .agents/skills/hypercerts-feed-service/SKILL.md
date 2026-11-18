---
name: hypercerts-feed-service
description: Call the Hypercerts Feed Service (feed.hypercerts.dev, dev.feed.hypercerts.dev). Covers the org.hypercerts.feed.getFeed and getFeedSkeleton POST procedures, the hypercertsFeed and maearthFeed feed IDs, params (viewerDid, kinds, actorDid, trustedEvaluators, organizationQuality), cursor paging, UnsupportedFeed and InvalidRequest errors, the MaEarth Following feed (update, repost, project-follow, account-follow, funding-receipt), the flat item shape (uri, author, kind, sortAt, subject, content), and checking that a feed works or how fast new records appear.
license: MIT OR Apache-2.0
---

# Hypercerts Feed Service

Use this skill to build a client for, test, or debug the Hypercerts Feed Service HTTP API. To change the service itself, read the repository's `AGENTS.md` instead. This skill does not cover Hyperindex or the Hypercerts API's Lua endpoints.

## Hosts

| Environment | Base URL                          |
| ----------- | --------------------------------- |
| Production  | `https://feed.hypercerts.dev`     |
| Dev         | `https://dev.feed.hypercerts.dev` |

`GET /health` only shows the process is alive. The MaEarth feed is experimental and must be enabled per deployment with `MAEARTH_FEED_ENABLED=true`. If a host returns `UnsupportedFeed` for it, it is off there or the change has not been redeployed.

## Request

Both procedures take the same JSON body:

```text
POST /xrpc/org.hypercerts.feed.getFeed           # flat items: uri, author, kind, sortAt, ...
POST /xrpc/org.hypercerts.feed.getFeedSkeleton   # { uri } items only
Content-Type: application/json

{ feedId, params, limit?, cursor? }
```

- These are not Bluesky's `app.bsky.feed.getFeedSkeleton`.
- `limit` defaults to 20 and must be 1–50.
- `cursor` goes at the top level, never inside `params`. Send it back unchanged until no cursor is returned. A cursor only works with the `feedId` that issued it.

### Hypercerts feed

```ts
feedId: 'org.hypercerts.feed.defs#hypercertsFeed'
params: {
  $type: 'org.hypercerts.feed.defs#hypercertsFeedParams'
  viewerDid: string // required unless using service auth
  trustedEvaluators?: string[] // DIDs whose endorsed accounts join the scope
  organizationQuality?: {
    allowed: ('high-quality' | 'standard' | 'draft' | 'likely-test')[]
    includeUnrated: boolean
  }
  kinds?: (
    | 'cert'
    | 'collection'
    | 'project-with-cert'
    | 'evaluation'
    | 'measurement'
    | 'endorsement'
    | 'update'
  )[] // omitted or empty = all; the former dotted names are rejected
}
```

The feed covers accounts the viewer follows (`app.certified.graph.follow`) plus accounts endorsed by `trustedEvaluators`, minus the viewer. `getFeed` returns the same flat item shape for both feeds (see [Item shape](#item-shape)); the Hypercerts feed hydrates `author` and adds `content`:

```ts
{
  uri: 'at://…', cid, author: { did, displayName?, avatar? }, kind: 'evaluation', sortAt, createdAt,
  subject: { $type: 'org.hypercerts.feed.defs#recordView', uri, cid }, // evaluation: the evaluated record; endorsement: an actorView; others none
  content: { $type: 'org.hypercerts.feed.defs#evaluationView', summary },
}
```

Hypercerts `content` is `activityView` (cert), `collectionView` (collection, project-with-cert), `evaluationView`, `measurementView` or `updateView`. Measurements and updates list every record they are about in `content.subjects[]`. An endorsement has no `content`.

### Item shape

```ts
{
  uri: string // the item's own record
  cid?: string // that record's CID; set for every kind
  author: { did: string; displayName?: string; avatar?: unknown } // the record's author, the authority of uri
  kind: string // kebab-case, from the lists in this skill; tolerate unknown values
  sortAt: string // the time the feed is ordered by and the cursor encodes, UTC
  createdAt?: string // the record's own createdAt, unchanged; absent when unusable
  subject?: { $type: '…#recordView', uri, cid?, likeCount?, repostCount?, replyCount? } | { $type: '…#actorView', did, displayName?, avatar? }
  likeCount?: number; repostCount?: number; replyCount?: number // counts of `uri`; MaEarth update items (all three) and funding-receipt items (no replyCount)
  content?: object // Hypercerts feed only
}
```

Only `uri`, `author`, `kind` and `sortAt` are always present. Ignore fields and `$type` values you do not know. `subject` mirrors the record's own `subject` field, so it names what the item points at, not the item.

### MaEarth feed (experimental)

```ts
feedId: 'org.hypercerts.feed.defs#maearthFeed'
params: {
  $type: 'org.hypercerts.feed.defs#maearthFeedParams'
  viewerDid: string // required unless using service auth
  kinds?: ('update' | 'repost' | 'project-follow' | 'account-follow' | 'funding-receipt')[] // omitted or empty = all; the former post, projectFollow and accountFollow are rejected
  actorDid?: string // narrows the viewer's Following feed to one author
}
```

`getFeed` items carry metadata and counts only. There is no `content`, and `author` is just a DID, because MaEarth hydrates items itself:

```ts
// a repost: the numbers describe the original post, so they sit on its subject
{
  uri: 'at://…/app.certified.feed.repost/…', cid, author: { did }, kind: 'repost', sortAt, createdAt?,
  subject: { $type: 'org.hypercerts.feed.defs#recordView', uri, cid?, likeCount, repostCount, replyCount },
}
// an update (a post): counts of the item itself
{ uri, cid, author: { did }, kind: 'update', sortAt, createdAt?, likeCount, repostCount, replyCount }
// project-follow: subject is a recordView with uri only (an entity follow names no CID)
// account-follow: subject is { $type: '…#actorView', did }
// funding-receipt: no subject or content; counts of the item itself, without replyCount
{ uri, cid, author: { did }, kind: 'funding-receipt', sortAt, createdAt?, likeCount, repostCount }
```

- An `update` is a post: an `org.hypercerts.context.attachment` record with `contentType` `update`.
- Counts: likes and reposts are distinct accounts, replies are every direct comment (not replies to replies). Counts always describe the URI beside them: an `update` item carries its own, a `funding-receipt` item its own likes and reposts only (no `replyCount`), a `repost` item none (its original post's counts are on `subject`), and follows have none. `getFeedSkeleton` has none. They are current state, so they can change between pages.
- Projects are `org.hypercerts.collection` records of type `project`.
- A repost appears only if the reposter is someone the viewer follows. The viewer's own reposts never appear.
- A `funding-receipt` is an `org.hypercerts.funding.receipt` record. It appears when its `for` is a project the viewer follows, or its `to` or `from` is an account the viewer follows. Its publisher (`author.did`) never qualifies it, and the viewer's own receipts appear only through the project or `to` rules. It has no `subject`, and its `createdAt` is the receipt's own. It is sorted by the receipt's `occurredAt`, then `createdAt`, so `sortAt` is its effective time and `createdAt` can be later than items listed after it. Read the record at `uri` for amount and parties.
- A receipt is an unverified claim by its publisher: any account can publish one naming a followed project or account, so check the publisher (`author.did`) and the receipt's parties before showing it.
- The service does not apply MaEarth's privacy or hidden-post rules. MaEarth must filter items before showing them.

### Example

```bash
curl -s -X POST https://feed.hypercerts.dev/xrpc/org.hypercerts.feed.getFeed \
  -H 'content-type: application/json' \
  -d '{"feedId":"org.hypercerts.feed.defs#maearthFeed","params":{"$type":"org.hypercerts.feed.defs#maearthFeedParams","viewerDid":"did:plc:<viewer>"},"limit":50}' \
  | jq '.feed[] | {uri, kind, sortAt}'
```

### Service auth (optional)

Send `Authorization: Bearer <AT Protocol service JWT>`:

- `aud` is the feed service's DID.
- `lxm` is the exact endpoint NSID.
- `jti` is unique for each request, because each token works only once.

With a valid token you can omit `viewerDid`. If you do send one, it must match the token's issuer.

## Errors

| Status | Error             | Cause                                                                                   |
| ------ | ----------------- | --------------------------------------------------------------------------------------- |
| 400    | `InvalidRequest`  | Malformed body, missing `params` or `$type`, or no `viewerDid` on an anonymous request  |
| 422    | `InvalidRequest`  | Unknown `kinds` value, or `limit` outside 1–50                                          |
| 400    | `UnsupportedFeed` | `feedId` is not enabled on that host                                                    |
| 400    | `InvalidCursor`   | Malformed cursor, or one from another feed. Discard it and request the first page again |
| 401    | —                 | Invalid, expired or reused service JWT; never falls back to anonymous                   |
| 503    | —                 | Service-auth replay store is full; retry later                                          |

## Pitfalls

- `uri` is the item's own record and `subject` is what that record points at (a repost's original post, a follow's target). The skeleton's items are `{ uri }`, not `{ subject }`.
- A `getFeed` page can be shorter than `limit`, or empty, and still return a cursor. Invalid source records are dropped without being replaced, so keep paging.
- Results reflect the current state, not history. Deleted records leave the feed within seconds, and pages fetched at different times may shift.
- On the MaEarth feed, items dated more than 5 minutes in the future are hidden. A record without `createdAt` is dated by when the indexer stored it.
- Both feeds return the sort time as `sortAt`, exactly the value the order and the cursor use. `createdAt` is the record's own value (it can carry an offset, so compare instants, not strings) and is omitted when the record has none or it is malformed, so use `sortAt` to order or merge.
- Neither feed has a kind for likes.

## Checking a feed works

1. Send the same body to `getFeedSkeleton` and `getFeed`. The `getFeed` `uri` values should be the skeleton's `uri` values in the same order, minus any invalid records it dropped. The MaEarth feed drops nothing, so its lists should match exactly. Data can change between the two requests, so retry before treating a difference as a bug.
2. Page to the end by following the cursor. Judge order by the feed's own order (the skeleton and `getFeed` list the same URIs in the same order); `sortAt` must never increase down the list. Do not judge it by `createdAt`: that is the record's own value, so it can be absent or out of order, for example for an item ordered by when it was indexed or a `funding-receipt` ordered by its `occurredAt`. Records can change while you page, so a duplicate `uri` is a bug only if it repeats when the data is not changing.
3. Filter by one kind. Only that kind should come back, and `kinds: ["bogus"]` should return 422.
4. To measure speed, note the time on your own machine when you write the record, from an account the viewer follows. Poll `getFeed` every 1–2 seconds and compare that time with when the record first appears. Don't rely on the record key, which doesn't always contain a timestamp. On 2026-11-10, new reposts appeared in about 2 seconds on dev and 3 seconds on production.
