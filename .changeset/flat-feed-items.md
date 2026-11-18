---
'@hypercerts/hypercerts-feed-service': major
---

- Breaking: `getFeedSkeleton` items are `{ uri }` instead of `{ subject }`, for both feeds.
- Breaking: `getFeed` returns one flat `itemView` per record instead of `{ subject, view }`, for both feeds. Read `uri`, `cid`, `author`, `kind`, `sortAt`, `createdAt`, `subject` and `content` from the item; `hypercertsFeedView` and `maearthFeedView` are gone, and `actor` is now `author`.
- Breaking: `kind` and the `kinds` parameter use kebab-case names, and old names are rejected with `InvalidRequest`. Hypercerts: `cert`, `collection`, `project-with-cert`, `evaluation`, `measurement`, `endorsement`, `update`. MaEarth: `update` (was `post`), `repost`, `project-follow`, `account-follow`.
- The `kind` label of the `hypercerts_feed_result_kinds_total` metric uses the new names.
- `sortAt` is the time the feed is ordered by and the cursor encodes. `createdAt` is the record's own value.
- `subject` mirrors the record's own `subject`, as a `recordView` or an `actorView`. In Hypercerts items, the evaluation `target` and the endorsement `content.subject` become `subject`, `endorsementView` is removed, and measurement and update `content` list every record in `subjects`. `createdAt` leaves `content`.
- MaEarth `update` items carry their own `likeCount`, `repostCount` and `replyCount`. A repost item has none; its original post's counts and the CID the repost names are on its `subject`.
- The Hypercerts feed excludes records whose effective timestamp is outside years 0001 through 9999 UTC, such as a `createdAt` of `9999-12-31T23:59:59-12:00`, so `sortAt` and the cursor are always valid datetimes.
