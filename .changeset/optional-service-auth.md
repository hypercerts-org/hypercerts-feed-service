---
"@hypercerts/hypercerts-feed-service": minor
---

Feed requests can now use AT Protocol service authentication. If a request includes a valid token, the token's issuer becomes the feed viewer. Requests without a token still need `params.viewerDid`. Authenticated tokens must include a non-empty `jti` of no more than 256 UTF-8 bytes and can be used only once per running process; retries require a fresh token, including after downstream failures.

Replay protection allows up to 512 live entries per verified issuer and 4,096 live entries per process. It is not shared across replicas or restarts. A full live issuer quota or replay store returns HTTP 503 until entries expire, preserving capacity for other issuers until the global bound is reached.

Before upgrading, set `SERVICE_DID` to this service's DID, even if you do not use authentication. It must be a bare DID, without `#serviceId`. If it is a hostname-level `did:web` and the matching hostname points to this service, `GET /.well-known/did.json` now publishes a `#hypercerts_feed` service entry at that hostname for discovery.

The `did#serviceId` format from AT Protocol Proposal 0014 is not supported yet because `@atproto/lex-server` does not support it.
