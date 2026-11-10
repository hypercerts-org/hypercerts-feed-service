# Hypercerts Feed Service

A read-only service that serves Hypercerts activity feeds over XRPC. It reads the current records and labels that HappyView indexes into PostgreSQL, picks and orders the items for a viewer, and returns them as a feed page.

It does not ingest or write records, call PDS or AppView APIs, or keep history. Results reflect HappyView's current data.

## Endpoints

| Route                                            | Purpose                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `POST /xrpc/org.hypercerts.feed.getFeedSkeleton` | Ordered page of source record AT-URIs, for clients that hydrate records themselves |
| `POST /xrpc/org.hypercerts.feed.getFeed`         | The same page with each item's view (kind, actor, and content)                     |
| `GET /`                                          | Short JSON description of the service                                              |
| `GET /.well-known/did.json`                      | DID document when `SERVICE_DID` is a `did:web`                                     |
| `GET /health`, `GET /ready`                      | Liveness and database readiness (keep private)                                     |

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
curl -sS http://localhost:3000/xrpc/org.hypercerts.feed.getFeed \
  -H 'content-type: application/json' \
  --data '{
    "feedId": "org.hypercerts.feed.defs#hypercertsFeed",
    "params": {
      "$type": "org.hypercerts.feed.defs#hypercertsFeedParams",
      "viewerDid": "did:plc:ar7c4by46qjdydhdevvrndac",
      "trustedEvaluators": ["did:plc:ewvi7nxzyoun6zhxrhs64oiz"],
      "organizationQuality": { "allowed": ["high-quality", "standard"], "includeUnrated": false }
    },
    "limit": 20
  }'
```

```json
{
  "feed": [
    {
      "subject": "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/org.hypercerts.context.evaluation/3kpn",
      "view": {
        "$type": "org.hypercerts.feed.defs#hypercertsFeedView",
        "kind": "evaluation.create",
        "actor": { "did": "did:plc:ewvi7nxzyoun6zhxrhs64oiz", "displayName": "Evaluator" },
        "content": { "$type": "org.hypercerts.feed.defs#evaluationView", "summary": "Strong evidence", "...": "..." }
      }
    }
  ],
  "cursor": "eyJ2ZXJzaW9uIjox..."
}
```

### MaEarth Following feed (experimental)

`feedId`: `org.hypercerts.feed.defs#maearthFeed`

Off by default; set `MAEARTH_FEED_ENABLED=true` to turn it on. When off, requests for it return `UnsupportedFeed`. Kinds: `post`, `projectFollow`, `accountFollow`, `repost`. Optional params: `kinds` and `actorDid` (narrows the viewer's Following scope to one author).

```bash
curl -sS http://localhost:3000/xrpc/org.hypercerts.feed.getFeed \
  -H 'content-type: application/json' \
  --data '{
    "feedId": "org.hypercerts.feed.defs#maearthFeed",
    "params": {
      "$type": "org.hypercerts.feed.defs#maearthFeedParams",
      "viewerDid": "did:plc:cccccccccccccccccccccccc",
      "kinds": ["post", "repost"]
    },
    "limit": 20
  }'
```

`getFeed` returns metadata only (no hydrated content), which MaEarth uses to merge the feed with its own data:

```json
{
  "subject": "at://did:plc:dddddddddddddddddddddddd/app.certified.feed.repost/3jzfcijpj2zd",
  "view": {
    "$type": "org.hypercerts.feed.defs#maearthFeedView",
    "kind": "repost",
    "createdAt": "2026-10-14T12:00:00.123456Z",
    "repostedPostUri": "at://did:plc:eeeeeeeeeeeeeeeeeeeeeeee/org.hypercerts.context.attachment/original"
  }
}
```

Project follows carry `followedProjectUri`, and account follows carry `followedDid`.

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
