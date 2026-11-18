---
'@hypercerts/hypercerts-feed-service': minor
---

Add an experimental MaEarth Following feed, registered only when `MAEARTH_FEED_ENABLED=true` (default off), with viewer-scoped posts, project/account follows, and reposts. The existing getFeed endpoint returns a MaEarth merge-metadata view with the record's own `createdAt` (the sort time is not exposed), the author as `actor: { did }`, and a `target` for reposts (`{ uri }`), project follows (`{ uri }`) and account follows (`{ did }`); skeleton items remain URI-only. Items dated more than five minutes after the database's statement time are hidden. MaEarth retains content hydration, privacy filtering, discovery, and gift merging.
