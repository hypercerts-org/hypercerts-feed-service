---
'@hypercerts/hypercerts-feed-service': minor
---

- MaEarth `getFeed` `update` items include `likeCount`, `repostCount` and `replyCount`; a repost item shows its original post's counts on its `subject`; follow items and `getFeedSkeleton` carry none.
- MaEarth now reads HappyView's `happyview_record_refs` table. Grant `SELECT` on it to the feed role before deploying: both `getFeed` and `getFeedSkeleton` fail until it is granted. Keep the table complete, or counts will be too low.
