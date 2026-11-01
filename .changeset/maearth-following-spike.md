---
'@hypercerts/hypercerts-feed-service': minor
---

Add an experimental MaEarth Following feed, registered only when `MAEARTH_FEED_ENABLED=true` (default off), with viewer-scoped posts, project/account follows, and reposts. The existing getFeed endpoint returns a MaEarth merge-metadata view with the effective sort timestamp and repost target; skeleton items remain URI-only. MaEarth retains content hydration, privacy filtering, discovery, and gift merging.
