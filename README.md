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

| Route                                            | Purpose                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /xrpc/org.hypercerts.feed.getFeedSkeleton` | Ordered page of `{ uri }` items, the AT-URI of each item's own record, for clients that hydrate records themselves                                                                                                                                        |
| `POST /xrpc/org.hypercerts.feed.getFeed`         | The same page as flat items (`uri`, `cid`, `author`, `kind`, `sortAt`, and where they apply `subject`, counts and `content`). Invalid records are dropped, so a page can be short or empty and still have a cursor; keep paging while a cursor is present |
| `GET /`                                          | Short JSON description of the service                                                                                                                                                                                                                     |
| `GET /.well-known/did.json`                      | DID document when `SERVICE_DID` is a `did:web`                                                                                                                                                                                                            |
| `GET /health`, `GET /ready`                      | Liveness and database readiness (keep private)                                                                                                                                                                                                            |

Both feed procedures take the same JSON body:

```json
{ "feedId": "...", "params": { "$type": "..." }, "limit": 20, "cursor": "..." }
```

Callers can be anonymous (they must then send `params.viewerDid`) or use AT Protocol service auth, where the verified token issuer is the viewer. Send a returned `cursor` back at the top level to get the next page.

Both feeds return the same flat item shape. Only `uri`, `author`, `kind` and `sortAt` are required; clients must ignore fields and `$type` values they do not know. `sortAt` is the time the feed is ordered by (and the cursor encodes); `createdAt` is the record's own value; `subject` is what the record points at, a `recordView` or an `actorView`. The full field list and the kind table are in [docs/api.md](docs/api.md#item-shape-both-feeds).

## Feeds

### Hypercerts feed

`feedId`: `org.hypercerts.feed.defs#hypercertsFeed`

Activity from accounts the viewer follows, optionally widened by trusted evaluators' endorsements and filtered by organization quality labels. Kinds: `cert`, `collection`, `project-with-cert`, `evaluation`, `measurement`, `endorsement`, `update`.

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
      "uri": "at://did:plc:nfd56jdcukm76ogr43ckjvr7/app.certified.badge.award/3mywt7grsgy2h",
      "cid": "bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u",
      "author": {
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
      "kind": "endorsement",
      "sortAt": "2026-10-28T13:10:50.018000Z",
      "createdAt": "2026-10-28T13:10:50.018Z",
      "subject": {
        "$type": "org.hypercerts.feed.defs#actorView",
        "did": "did:plc:2zaqs2fpnxmzvjepb2kksahq"
      }
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjox..."
}
```

### MaEarth Following feed (experimental)

`feedId`: `org.hypercerts.feed.defs#maearthFeed`

Off by default; set `MAEARTH_FEED_ENABLED=true` to turn it on (it is on for all three hosted instances). When off, requests for it return `UnsupportedFeed`. Kinds: `update`, `repost`, `project-follow`, `account-follow`. Optional params: `kinds` and `actorDid` (narrows the viewer's Following scope to one author).

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

`getFeed` returns metadata and engagement counts only (no `content`, and `author` is a DID alone), which MaEarth uses to merge the feed with its own data:

```json
{
  "feed": [
    {
      "uri": "at://did:plc:bqkfguw3v76x5arrun2vybp2/app.certified.feed.repost/3mzwurdidkk25",
      "cid": "bafyreia3tbsfxe3cc75xrxyyn6qc42oupi73fxiox76prlyi5bpx7hr72u",
      "author": { "did": "did:plc:bqkfguw3v76x5arrun2vybp2" },
      "kind": "repost",
      "sortAt": "2026-11-10T07:03:34.692000Z",
      "createdAt": "2026-11-10T07:03:34.692Z",
      "subject": {
        "$type": "org.hypercerts.feed.defs#recordView",
        "uri": "at://did:plc:uuvfp7xadcud56pjxbka26lc/org.hypercerts.context.attachment/3mxbyjkmrkk2u",
        "cid": "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm",
        "likeCount": 4,
        "repostCount": 2,
        "replyCount": 0
      }
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjox..."
}
```

`author` is the record's author. `createdAt` is the record's own value, unchanged, and is omitted when it is unusable; `sortAt` is the time the feed ordered by. A repost and a project follow carry a `recordView` `subject`, an account follow an `actorView`, and an `update` none. Counts always describe the URI beside them: an `update` carries its own `likeCount`, `repostCount` and `replyCount`, while a repost's numbers (its original post's) sit on its `subject`; follows have none.

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
