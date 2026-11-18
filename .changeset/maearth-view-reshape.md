---
'@hypercerts/hypercerts-feed-service': minor
---

- Breaking, experimental MaEarth feed only: `getFeed` views replace `actorDid` with `actor: { did }`, now on every item, and replace `repostedPostUri`, `followedProjectUri` and `followedDid` with `target: { uri }` or `target: { did }`. A post has no `target`. `actor` and `target` are open objects, so ignore fields you do not know.
- MaEarth `getFeed` `createdAt` is now the record's own `createdAt`, unchanged, instead of the sort time. It is omitted when the record's value is missing or not a valid datetime. Order, the cursor and the five-minute future cutoff are unchanged.
