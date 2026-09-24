# @hypercerts/hypercerts-feed-service

## 0.2.0

### Minor Changes

- [#22](https://github.com/hypercerts-org/hypercerts-feed-service/pull/22) [`0c8b281`](https://github.com/hypercerts-org/hypercerts-feed-service/commit/0c8b281472c0860cfffd5f063397df486e9accf6) Thanks [@Kzoeps](https://github.com/Kzoeps)! - Feed requests can now use AT Protocol service authentication. If a request includes a valid token, the token's issuer becomes the feed viewer. Requests without a token still need `params.viewerDid`. Authenticated tokens must include a non-empty `jti` of no more than 256 UTF-8 bytes and can be used only once per running process; retries require a fresh token, including after downstream failures.

  Replay protection allows up to 512 live entries per verified issuer and 4,096 live entries per process. It is not shared across replicas or restarts. A full live issuer quota or replay store returns HTTP 503 until entries expire, preserving capacity for other issuers until the global bound is reached.

  Before upgrading, set `SERVICE_DID` to this service's DID, even if you do not use authentication. It must be a bare DID, without `#serviceId`. If it is a hostname-level `did:web` and the matching hostname points to this service, `GET /.well-known/did.json` now publishes a `#hypercerts_feed` service entry at that hostname for discovery.

  Node HTTP requests now retain working service authentication after their POST body finishes. The service upgrades `@atproto/lex-server` to 0.1.19 and avoids passing its prematurely aborted request signal to DID resolution. The `did#serviceId` format from AT Protocol Proposal 0014 is not supported yet because `@atproto/lex-server` does not support it.

## 0.1.1

### Patch Changes

- [#18](https://github.com/hypercerts-org/hypercerts-feed-service/pull/18) [`ac800bc`](https://github.com/hypercerts-org/hypercerts-feed-service/commit/ac800bc0504e8ba6bab110422bc46100792105c5) Thanks [@Kzoeps](https://github.com/Kzoeps)! - Describe the feed service and its public XRPC procedures at `GET /`.

## 0.1.0

### Initial Release

- [#7](https://github.com/hypercerts-org/hypercerts-feed-service/pull/7) [`07fc96f`](https://github.com/hypercerts-org/hypercerts-feed-service/commit/07fc96f229a4a9200331c94d6fdc15b68c271268) Thanks [@Kzoeps](https://github.com/Kzoeps)! - Introduce the initial version of Hypercerts Feed Service.

  Available in this release:

  - `org.hypercerts.feed.getFeedSkeleton`, returning URI-only feed subjects.
  - `org.hypercerts.feed.getFeed`, returning validated feed-specific views with actor summaries.
  - The Hypercerts feed algorithm, including follow-based scope, evaluator expansion, organization-quality filters, kind filtering, keyset pagination, and current-state hydration for all eight supported feed kinds.
  - Read-only Hyperindex PostgreSQL access, health and readiness endpoints, private Prometheus metrics, bounded requests and queries, and graceful shutdown.
  - Automated Changesets release notes, Git tags, and GitHub Releases with approval-gated CI and exact-commit validation.
