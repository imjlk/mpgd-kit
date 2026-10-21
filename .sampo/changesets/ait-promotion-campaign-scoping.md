---
npm/@mpgd/adapter-ait: patch
---

Store new Apps in Toss promotion markers under `mpgd:ait:promotion-grant:v2:<campaignId>:<idempotencyKey>`, and write a v1 dispatch fence at `mpgd:ait:promotion-grant:v1:<idempotencyKey>` before that copy and before payout. The fence includes `campaignId`. Until a granted receipt replaces it, its status is `fenced`, which a rolled-back @mpgd/adapter-ait 0.20.1 bridge treats as already fenced and does not dispatch or remove. If that v1 write fails, the claim stays pending and nothing is dispatched.

A legacy v1 marker with no `campaignId` is still stamped in place before any scoped copy. If that stamp cannot be stored, or the legacy marker cannot be read, the claim stays pending, nothing is copied, and an authority receipt is not cached or returned. The read-failure behavior is an approved fail-closed decision: a markerless authority receipt is not persisted while the legacy read is failing. A v1 marker bound to this campaign is this campaign's record. One bound to another campaign stays pending and is not overwritten or paid again.

When `authorizePromotionGrant` is configured, it remains the primary dispatch fence. The local markers do not authorize a payout the authorizer did not approve, and they do not add a dispatch path that skips it. A pending scoped copy does not hide a granted v1 receipt: a retry sees that receipt and does not dispatch again. Host bridges that share storage share the claim lock. Server-issued idempotency keys should stay unique across campaigns.
