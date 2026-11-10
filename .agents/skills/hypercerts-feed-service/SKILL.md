---
name: hypercerts-feed-service
description: Call the Hypercerts Feed Service (feed.hypercerts.dev, dev.feed.hypercerts.dev). Covers the org.hypercerts.feed.getFeed and getFeedSkeleton POST procedures, the hypercertsFeed and maearthFeed feed IDs, params (viewerDid, kinds, actorDid, trustedEvaluators, organizationQuality), cursor paging, UnsupportedFeed and InvalidRequest errors, the MaEarth Following feed (post, projectFollow, accountFollow, repost), and checking that a feed works or how fast new records appear.
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
POST /xrpc/org.hypercerts.feed.getFeed           # items with views
POST /xrpc/org.hypercerts.feed.getFeedSkeleton   # items with URIs only
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
    | 'cert.create'
    | 'collection.create'
    | 'project.created_with_cert'
    | 'evaluation.create'
    | 'measurement.create'
    | 'update.create'
    | 'endorsement.award'
  )[] // omitted or empty = all
}
```

The feed covers accounts the viewer follows (`app.certified.graph.follow`) plus accounts endorsed by `trustedEvaluators`, minus the viewer. `getFeed` items look like:

```ts
{ subject: 'at://…', view: { $type: 'org.hypercerts.feed.defs#hypercertsFeedView', kind, actor: { did, displayName?, avatar? }, content } }
```

### MaEarth feed (experimental)

```ts
feedId: 'org.hypercerts.feed.defs#maearthFeed'
params: {
  $type: 'org.hypercerts.feed.defs#maearthFeedParams'
  viewerDid: string // required unless using service auth
  kinds?: ('post' | 'projectFollow' | 'accountFollow' | 'repost')[] // omitted or empty = all
  actorDid?: string // narrows the viewer's Following feed to one author
}
```

`getFeed` items carry metadata only. There is no actor or content, because MaEarth hydrates items itself:

```ts
{
  subject: 'at://…',
  view: {
    $type: 'org.hypercerts.feed.defs#maearthFeedView',
    kind,
    createdAt,
    repostedPostUri?, // repost only
    followedProjectUri?, // projectFollow only
    followedDid?, // accountFollow only
  },
}
```

- Posts are `org.hypercerts.context.attachment` records.
- Projects are `org.hypercerts.collection` records of type `project`.
- A repost appears only if the reposter is the viewer or someone the viewer follows.

### Example

```bash
curl -s -X POST https://feed.hypercerts.dev/xrpc/org.hypercerts.feed.getFeed \
  -H 'content-type: application/json' \
  -d '{"feedId":"org.hypercerts.feed.defs#maearthFeed","params":{"$type":"org.hypercerts.feed.defs#maearthFeedParams","viewerDid":"did:plc:<viewer>"},"limit":50}' \
  | jq '.feed[] | {subject, kind: .view.kind}'
```

### Service auth (optional)

Send `Authorization: Bearer <AT Protocol service JWT>`:

- `aud` is the feed service's DID.
- `lxm` is the exact endpoint NSID.
- `jti` is unique for each request, because each token works only once.

With a valid token you can omit `viewerDid`. If you do send one, it must match the token's issuer.

## Errors

| Status | Error             | Cause                                                                                  |
| ------ | ----------------- | -------------------------------------------------------------------------------------- |
| 400    | `InvalidRequest`  | Malformed body, missing `params` or `$type`, or no `viewerDid` on an anonymous request |
| 422    | `InvalidRequest`  | Unknown `kinds` value, or `limit` outside 1–50                                         |
| 400    | `UnsupportedFeed` | `feedId` is not enabled on that host                                                   |
| 401    | —                 | Invalid, expired or reused service JWT; never falls back to anonymous                  |
| 503    | —                 | Service-auth replay store is full; retry later                                         |

## Pitfalls

- `subject` is a plain AT-URI string, not an object. Use `.feed[].subject`, not `.subject.uri`.
- A `getFeed` page can be shorter than `limit`, or empty, and still return a cursor. Invalid source records are dropped without being replaced, so keep paging.
- Results reflect the current state, not history. Deleted records leave the feed within seconds, and pages fetched at different times may shift.
- On the MaEarth feed, items dated more than 5 minutes in the future are hidden. A record without `createdAt` is dated by when the indexer stored it.
- Only the MaEarth feed returns timestamps. Neither feed has a kind for likes.

## Checking a feed works

1. Send the same body to `getFeedSkeleton` and `getFeed`. Both should return the same subject URIs in the same order, with the same cursor.
2. Page to the end. There should be no duplicate subjects, and MaEarth `createdAt` values should never increase.
3. Filter by one kind. Only that kind should come back, and `kinds: ["bogus"]` should return 422.
4. To measure speed, create a record from an account the viewer follows and poll `getFeed` every 1–2 seconds. Compare the time the record first appears with the time in its record key. Decode the key as base32, using the alphabet `234567abcdefghijklmnopqrstuvwxyz`; shifting the value right by 10 bits gives microseconds since the Unix epoch. On 2026-11-10, new reposts appeared in about 2 seconds on dev and 3 seconds on production.
