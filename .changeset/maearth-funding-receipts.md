---
'@hypercerts/hypercerts-feed-service': minor
---

- MaEarth feed adds the `funding-receipt` kind: `org.hypercerts.funding.receipt` records for a followed project, or to or from a followed account. Items have `author` (the publisher), the receipt's own `createdAt`, and no `subject` or `content`.
- `funding-receipt` items carry `likeCount` and `repostCount`, but no `replyCount`.
- Receipts are ordered by `occurredAt`, then `createdAt`, then `indexed_at`; `sortAt` is that time.
- Omitted or empty `kinds` now includes `funding-receipt` and scans the whole receipt collection; send `kinds` without `funding-receipt` to skip it.
- Anyone can publish a receipt naming a followed project or account, so check its publisher and parties before showing it.
