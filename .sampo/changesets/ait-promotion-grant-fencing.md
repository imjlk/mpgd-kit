---
npm/@mpgd/adapter-ait: patch
---

Stop a second Apps in Toss promotion payout when a granted receipt could not be stored, when grant and recover overlap, or when an explicit failure marker could not be written. Grant and recover for one idempotency key now share a lock across campaigns, re-read storage and the bridge-local receipt cache before payout, and do not evict a receipt whose durable write failed.

New promotion markers are stored under `mpgd:ait:promotion-grant:v2:<campaignId>:<idempotencyKey>` and include `campaignId`. Legacy `v1` markers, keyed only by the idempotency key, remain readable. The first campaign that reconciles an unbound legacy marker binds it; another campaign does not receive that receipt. Concurrent reconciliation of the same key cannot bind it twice. Server-issued idempotency keys should stay unique across campaigns. A v2 marker whose embedded campaign id does not match its key stays pending and is not overwritten.

A stored explicit failure can be cleared by an authority `retry`. A failure whose diagnostic write did not land stays blocked in that process. An authority retry of a legacy pending marker also removes the migrated v2 copy, so that copy cannot force a second resolver call and block the authorized payout.

An older host that does not implement `promotions.recoverReward` now answers `{ status: 'pending' }` instead of throwing. That includes a protocol validator rejection reported as `AIT_BRIDGE_REQUEST_FAILED`, not only `UNSUPPORTED_METHOD`. `grantReward` is unchanged. A late promotion observer rejection is ignored and cannot reject the payout result.
