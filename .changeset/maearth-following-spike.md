---
'@hypercerts/hypercerts-feed-service': minor
---

Add an experimental MaEarth Following feed, registered only when `MAEARTH_FEED_ENABLED=true` (default off), with viewer-scoped updates, project/account follows, and reposts. `getFeed` returns flat items with merge metadata only: the record's own `createdAt`, the feed's `sortAt`, the author as `author: { did }`, and a `subject` for reposts and follows; `getFeedSkeleton` items are `{ uri }`. Items dated more than five minutes after the database's statement time are hidden. MaEarth retains content hydration, privacy filtering, discovery, and gift merging.
