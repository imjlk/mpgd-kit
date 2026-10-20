---
npm/@mpgd/adapter-ait: patch
---

Stop a second Apps in Toss promotion payout when a granted receipt could not be stored, when grant and recover overlap, or when an explicit failure marker could not be written. Grant and recover for one campaign claim now share a lock, re-read storage and the bridge-local receipt cache before payout, and do not evict a receipt whose durable write failed.

New promotion markers are stored under `mpgd:ait:promotion-grant:v2:<campaignId>:<idempotencyKey>` and include `campaignId`. Legacy `v1` markers, keyed only by the idempotency key, remain readable. The first campaign that reconciles an unbound legacy marker binds it; another campaign does not receive that receipt. Server-issued idempotency keys should stay unique across campaigns.

An older host that does not implement `promotions.recoverReward` now answers `{ status: 'pending' }` instead of throwing `UNSUPPORTED_METHOD`. `grantReward` is unchanged. A late promotion observer rejection is ignored and cannot reject the payout result.
