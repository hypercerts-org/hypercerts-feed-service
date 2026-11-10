# Operations and configuration

## Configuration

For local development, copy `.env.example` to `.env`. For deployment, copy its values into the deployment's variable configuration. The process can load a local `.env`, but it never replaces variables already set in the environment.

| Variable                         | Required |   Default | Purpose                                                                                |
| -------------------------------- | -------: | --------: | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   |      yes |           | Dedicated read-only Postgres URL for the HappyView database                            |
| `SERVICE_DID`                    |      yes |           | DID identifying this service and required as the service-auth JWT audience             |
| `SERVICE_AUTH_MAX_AGE_SECONDS`   |       no |     `300` | Maximum service-auth JWT age; bounded from 1 through 3600 seconds                      |
| `DID_RESOLUTION_TIMEOUT_MS`      |       no |    `2000` | Total timeout for one HTTPS DID-document resolution; bounded from 100 through 60000 ms |
| `PORT`                           |       no |    `3000` | HTTP listen port                                                                       |
| `HOST`                           |       no | `0.0.0.0` | Public HTTP listen interface                                                           |
| `METRICS_HOST`                   |       no | `0.0.0.0` | Private metrics listen interface; used only when `METRICS_PORT` is set                 |
| `METRICS_PORT`                   |       no |  disabled | Enables the private `GET /metrics` listener on this port; must differ from `PORT`      |
| `LOG_LEVEL`                      |       no |    `info` | Pino log level                                                                         |
| `DATABASE_MAX_CONNECTIONS`       |       no |       `5` | Maximum pool size, capped at 20; the pool keeps one connection warm                    |
| `DATABASE_IDLE_TIMEOUT_MS`       |       no |   `60000` | Time before idle connections above the one-connection minimum are closed               |
| `DATABASE_CONNECTION_TIMEOUT_MS` |       no |    `2000` | Pool acquisition timeout                                                               |
| `DATABASE_STATEMENT_TIMEOUT_MS`  |       no |    `5000` | PostgreSQL statement timeout                                                           |
| `REQUEST_TIMEOUT_MS`             |       no |   `10000` | Maximum time allowed to receive an HTTP request; not a handler or database deadline    |
| `GRACEFUL_SHUTDOWN_MS`           |       no |   `10000` | Shutdown drain timeout                                                                 |
| `TRUSTED_QUALITY_LABELER_DIDS`   |       no |     empty | Comma-separated labeler DIDs trusted for current HappyView quality-label rows          |
| `MAEARTH_FEED_ENABLED`           |       no |   `false` | `true` registers the experimental MaEarth feed; unset or `false` leaves it off         |

For example, set `SERVICE_DID=did:web:dev.feed.hypercerts.dev` only when `https://dev.feed.hypercerts.dev` routes to this service; clients can discover its XRPC endpoint using `did:web:dev.feed.hypercerts.dev#hypercerts_feed`. This service does not publish a signing key: it verifies callers using their own DID documents. The DID service entry is for discovery and does not change JWT audience validation.

Service-auth audience verification currently accepts only the bare `SERVICE_DID`. [AT Protocol Proposal 0014](https://github.com/bluesky-social/proposals/blob/main/0014-service-auth-revised/README.md) defines the combined `did#serviceId` service reference, but the reference PDS currently emits the bare-DID service-auth audience and `@atproto/lex-server` does not yet support the combined audience form. This is separate from JWT `jti` replay protection, which this service now validates and consumes once per issuer in its bounded process-local replay state. Clients may still use a combined service reference for PDS proxy routing. When upstream support and PDS behavior are ready, update the verifier to accept an explicit allowlist of both audience forms.

If there are no configured trusted labelers, known organizations count as unrated whenever the request includes an organization-quality policy.

## Database access

Use a dedicated login that has only `SELECT` access. The service also sets `default_transaction_read_only=on` for every connection in the pool, but database grants are still the main security boundary.

Each service replica has its own limited in-process pool. When planning database connections, allow for `replica count × DATABASE_MAX_CONNECTIONS`. Use an external pooler if many replicas share a PostgreSQL server with few available connections.

Example operator setup:

```sql
CREATE ROLE hypercerts_feed_reader LOGIN PASSWORD '<managed-secret>';
GRANT CONNECT ON DATABASE happyview TO hypercerts_feed_reader;
GRANT USAGE ON SCHEMA public TO hypercerts_feed_reader;
GRANT SELECT ON TABLE public.happyview_records, public.happyview_labels
  TO hypercerts_feed_reader;
ALTER ROLE hypercerts_feed_reader SET default_transaction_read_only = on;
```

The service has no migrations or feed tables of its own. `/ready` checks that the database can be reached, PostgreSQL 16 can safely validate JSON and timestamp text, and the session is read-only. It does not check HappyView tables, labeler subscription health, label completeness, or ingestion freshness. See [`docs/database-contract.md`](database-contract.md) for the runtime schema contract.

Before cutover, grant the service read-only access to `happyview_records` and `happyview_labels`, confirm that trusted labeler subscriptions are configured, and verify the record collections needed by this service are being stored. A present label row proves only that HappyView currently projects that label; it does not prove that every label was ingested.

## Deployment

```bash
docker build -t hypercerts-feed-service .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL='postgresql://...' \
  -e SERVICE_DID='did:web:feed.example' \
  -e TRUSTED_QUALITY_LABELER_DIDS='did:plc:ar7c4by46qjdydhdevvrndac' \
  hypercerts-feed-service
```

Deploy the service beside HappyView and use private networking for the database.

To expose metrics, set a private metrics listener separate from the public application port:

```env
METRICS_HOST=0.0.0.0
METRICS_PORT=3001
```

Configure a compatible Prometheus collector to read `http://<private-service-host>:3001/metrics`. The `GET /metrics` response uses Prometheus-compatible exposition format. The listener has no application-level authentication, so do not attach a public domain or TCP proxy to the metrics port. Each replica exposes only its current in-memory registry; the collector owns aggregation, retention, and historical data. When `METRICS_PORT` is unset or empty, the metrics listener is disabled. `/metrics` remains unavailable on the public application port.

Set per-IP rate limits at the gateway. The first public policy allows 60 feed requests per minute for each client IP, with a burst of 20. When a client exceeds the limit, return HTTP 429 with `Retry-After`. Keep health and readiness private and outside this public limit. Adjust the limits using measured query response time and pool saturation.

The process limits request body size, HTTP request receive time, pool size, connection wait time, SQL statement duration, and DID-document resolution time. `REQUEST_TIMEOUT_MS` is not a deadline for the whole handler or query. After a complete POST body is buffered, downstream authentication uses a fresh signal because the current `@atproto/lex-server/nodejs` adapter aborts its request signal when the body ends normally. A client disconnect after the full body is received therefore does not cancel authentication or feed work; DID resolution and database timeouts still apply. Feed procedures allow browser requests from every origin and support `POST` preflight requests with `content-type` and `authorization` headers. They do not allow credentialed CORS requests. CORS does not authenticate callers or replace gateway rate limiting. Do not add rate-limit state to this service because separate replicas would disagree. Service-auth replay state is a separate bounded, process-local safeguard; it is not a distributed rate limiter.

## Endpoints for operators

`GET /` returns a small JSON description of the service and lists its public XRPC procedures. It does not query the database or report service readiness. For a hostname-level `did:web` configured as `SERVICE_DID`, `GET /.well-known/did.json` publishes a DID document with a `#hypercerts_feed` service entry (`HypercertsFeedService`) pointing to the HTTPS origin derived from that DID. The route uses the configured DID, not the request hostname. Non-`did:web` service DIDs do not publish a document here.

- `GET /.well-known/did.json`: serves the configured hostname-level `did:web` identity and `#hypercerts_feed` service entry; its endpoint comes from `SERVICE_DID`, not the request hostname.
- `GET /health`: checks only whether the process is alive.
- `GET /ready`: checks current database support and read-only state; the runtime schema contract is documented separately.
- Private metrics listener: when `METRICS_PORT` is set, `GET /metrics` exposes this replica's metrics in Prometheus-compatible exposition format on `METRICS_HOST:METRICS_PORT`; all other paths are rejected.
- `SIGTERM` and `SIGINT`: stop accepting requests, let current work finish, stop the optional metrics listener, and then close the database pool.
