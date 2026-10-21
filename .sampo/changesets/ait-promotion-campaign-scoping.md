---
npm/@mpgd/adapter-ait: patch
---

Store new Apps in Toss promotion markers under `mpgd:ait:promotion-grant:v2:<campaignId>:<idempotencyKey>`. A legacy `v1` marker with no `campaignId` is stamped in place before any scoped copy; if that stamp cannot be stored, the claim stays pending, nothing is copied, and another campaign still sees the unbound marker. A present but invalid `campaignId`, or one that names a different campaign, stays pending and is not overwritten or paid again.

An authority receipt from a failed storage read is not cached or returned when that write cannot bind an unbound legacy marker or finds another campaign's marker. Server-issued idempotency keys should stay unique across campaigns.
