---
'@hypercerts/hypercerts-feed-service': minor
---

- MaEarth `getFeed` items carry `author` and `subject` as open objects, so ignore fields you do not know: `author: { did }` on every item, and a `subject` that is a `recordView` for reposts and project follows or an `actorView` for account follows (an `update` has none).
- MaEarth `getFeed` `createdAt` is the record's own `createdAt`, unchanged, not the sort time. It is omitted when the record's value is missing or not a valid datetime. The sort time is returned as `sortAt`. Order, the cursor and the five-minute future cutoff are unchanged.
