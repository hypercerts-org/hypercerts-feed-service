---
'@hypercerts/hypercerts-feed-service': minor
---

- MaEarth `getFeed` views carry `actor` and `target` as open objects, so ignore fields you do not know: `actor: { did }` on every item, and `target: { uri }` or `target: { did }` for reposts and follows (a post has no `target`).
- MaEarth `getFeed` `createdAt` is the record's own `createdAt`, unchanged, not the sort time. It is omitted when the record's value is missing or not a valid datetime. Order, the cursor and the five-minute future cutoff are unchanged.
