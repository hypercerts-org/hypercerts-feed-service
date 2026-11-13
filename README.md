# Hypercerts Feed Service

A read-only service that serves Hypercerts activity feeds over XRPC. It reads the current records and labels that HappyView indexes into PostgreSQL, picks and orders the items for a viewer, and returns them as a feed page.

It does not ingest or write records, call PDS or AppView APIs, or keep history. Results reflect HappyView's current data.

## Hosted instances

| Environment | URL                                |
| ----------- | ---------------------------------- |
| Production  | `https://feed.hypercerts.dev`      |
| Staging     | `https://dev.feed.hypercerts.dev`  |
| Test        | `https://test.feed.hypercerts.dev` |

## Endpoints

| Route                                            | Purpose                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /xrpc/org.hypercerts.feed.getFeedSkeleton` | Ordered page of source record AT-URIs, for clients that hydrate records themselves                                                                                            |
| `POST /xrpc/org.hypercerts.feed.getFeed`         | The same page with a feed-specific view per item. Invalid records are dropped, so a page can be short or empty and still have a cursor; keep paging while a cursor is present |
| `GET /`                                          | Short JSON description of the service                                                                                                                                         |
| `GET /.well-known/did.json`                      | DID document when `SERVICE_DID` is a `did:web`                                                                                                                                |
| `GET /health`, `GET /ready`                      | Liveness and database readiness (keep private)                                                                                                                                |

Both feed procedures take the same JSON body:

```json
{ "feedId": "...", "params": { "$type": "..." }, "limit": 20, "cursor": "..." }
```

Callers can be anonymous (they must then send `params.viewerDid`) or use AT Protocol service auth, where the verified token issuer is the viewer. Send a returned `cursor` back at the top level to get the next page.

## Feeds

### Hypercerts feed

`feedId`: `org.hypercerts.feed.defs#hypercertsFeed`

Activity from accounts the viewer follows, optionally widened by trusted evaluators' endorsements and filtered by organization quality labels. Kinds: `cert.create`, `collection.create`, `project.created_with_cert`, `evaluation.create`, `measurement.create`, `update.create`, `endorsement.award`.

```bash
curl -sS https://feed.hypercerts.dev/xrpc/org.hypercerts.feed.getFeed \
  -H 'content-type: application/json' \
  --data '{
    "feedId": "org.hypercerts.feed.defs#hypercertsFeed",
    "params": {
      "$type": "org.hypercerts.feed.defs#hypercertsFeedParams",
      "viewerDid": "did:plc:m766f2lmgsdu2f363ja5d5hr"
    },
    "limit": 1
  }'
```

```json
{
  "feed": [
    {
      "subject": "at://did:plc:nfd56jdcukm76ogr43ckjvr7/app.certified.badge.award/3mywt7grsgy2h",
      "view": {
        "$type": "org.hypercerts.feed.defs#hypercertsFeedView",
        "kind": "endorsement.award",
        "actor": {
          "did": "did:plc:nfd56jdcukm76ogr43ckjvr7",
          "displayName": "holke.xyz",
          "avatar": {
            "$type": "org.hypercerts.defs#smallImage",
            "image": {
              "$type": "blob",
              "ref": { "$link": "bafkreiapzh7gatkrwfgrop7qweb7zllbqmqsjxcn7qyishwfkp4ept4kiy" },
              "mimeType": "image/jpeg",
              "size": 1154171
            }
          }
        },
        "content": {
          "$type": "org.hypercerts.feed.defs#endorsementView",
          "subject": { "did": "did:plc:2zaqs2fpnxmzvjepb2kksahq" },
          "createdAt": "2026-10-28T13:10:50.018Z"
        }
      }
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjox..."
}
```

### MaEarth Following feed (experimental)

`feedId`: `org.hypercerts.feed.defs#maearthFeed`

Off by default; set `MAEARTH_FEED_ENABLED=true` to turn it on (it is on for all three hosted instances). When off, requests for it return `UnsupportedFeed`. Kinds: `post`, `projectFollow`, `accountFollow`, `repost`. Optional params: `kinds` and `actorDid` (narrows the viewer's Following scope to one author).

```bash
curl -sS https://feed.hypercerts.dev/xrpc/org.hypercerts.feed.getFeed \
  -H 'content-type: application/json' \
  --data '{
    "feedId": "org.hypercerts.feed.defs#maearthFeed",
    "params": {
      "$type": "org.hypercerts.feed.defs#maearthFeedParams",
      "viewerDid": "did:plc:agicfaldjijjzm2rjnumzzw3",
      "kinds": ["repost"]
    },
    "limit": 1
  }'
```

`getFeed` returns metadata only (no hydrated content), which MaEarth uses to merge the feed with its own data:

```json
{
  "feed": [
    {
      "subject": "at://did:plc:bqkfguw3v76x5arrun2vybp2/app.certified.feed.repost/3mzwurdidkk25",
      "view": {
        "$type": "org.hypercerts.feed.defs#maearthFeedView",
        "kind": "repost",
        "createdAt": "2026-11-10T07:03:34.692000Z",
        "cid": "bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u",
        "actorDid": "did:plc:bqkfguw3v76x5arrun2vybp2",
        "repostedPostUri": "at://did:plc:uuvfp7xadcud56pjxbka26lc/org.hypercerts.context.attachment/3mxbyjkmrkk2u"
      }
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjox..."
}
```

Items carry their record `cid` and author `actorDid` (both optional in the Lexicon). Project follows carry `followedProjectUri`, and account follows carry `followedDid`.

Full request rules, selection, errors, and pagination: [docs/api.md](docs/api.md).

## Running it

You need Node.js 22.19+ and access to a HappyView PostgreSQL 16+ database through a read-only role.

```bash
cp .env.example .env   # set DATABASE_URL and SERVICE_DID
npm install
npm run build
npm start
```

Or with Docker:

```bash
docker build -t hypercerts-feed-service .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e SERVICE_DID='did:web:feed.example' \
  hypercerts-feed-service
```

All settings, the database role, metrics, and deployment notes: [docs/operations.md](docs/operations.md).

## Development

```bash
npm install
npm run dev          # watch mode
npm run lint
npm run check
npm test
npm run build
```

Integration tests need a disposable PostgreSQL database: `TEST_DATABASE_URL='postgresql://...' npm run test:integration`. See [docs/development.md](docs/development.md).

## Docs

- [API reference](docs/api.md)
- [Operations and configuration](docs/operations.md)
- [Development](docs/development.md)
- [Database contract](docs/database-contract.md)
- [Releasing](docs/RELEASING.md)

## License

Licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

The `app.bsky` Lexicon schemas in `lexicons/app/` come from Bluesky's [bsky](https://github.com/bluesky-social/bsky) repository, and the `com.atproto` schemas in `lexicons/com/` from its [atproto](https://github.com/bluesky-social/atproto) repository. These schemas keep their upstream license: MIT or Apache-2.0, Copyright (c) 2022-2026 Bluesky Social PBC, and Contributors.
