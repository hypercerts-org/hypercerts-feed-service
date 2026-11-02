---
'@hypercerts/hypercerts-feed-service': minor
---

Add an experimental MaEarth Following feed, registered only when `MAEARTH_FEED_ENABLED=true` (default off), with viewer-scoped posts, project/account follows, and reposts. The existing getFeed endpoint returns a MaEarth merge-metadata view with the effective sort timestamp, the repost target for reposts, the followed project URI for project follows, and the followed DID for account follows; skeleton items remain URI-only. Items dated more than five minutes after the database's statement time are hidden. MaEarth retains content hydration, privacy filtering, discovery, and gift merging.
