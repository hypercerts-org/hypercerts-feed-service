---
'@hypercerts/hypercerts-feed-service': minor
---

- MaEarth `getFeed` post and repost items now include `likeCount`, `repostCount` and `replyCount` (a repost shows its original post's counts); follow items and `getFeedSkeleton` carry none.
- MaEarth now reads HappyView's `happyview_record_refs` table: grant `SELECT` on it to the feed role and keep it complete, or counts will be 0 or too low.
