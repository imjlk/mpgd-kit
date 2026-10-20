---
npm/@mpgd/adapter-ait: patch
---

Stop a second Apps in Toss promotion payout when a granted receipt could not be stored, when grant and recover overlap, or when an explicit failure marker could not be written. Grant and recover for one idempotency key share a lock, re-read storage and the bridge-local receipt cache before payout, and do not evict a receipt whose durable write failed.

Promotion markers stay keyed by the claim id, `mpgd:ait:promotion-grant:v1:<idempotencyKey>`. New records include `campaignId`. A stored record whose campaign id differs stays pending and is not overwritten or paid again. Records without `campaignId` are unchanged. Campaign-scoped keys are a follow-up.

A stored explicit failure can be cleared by an authority `retry`. A failure whose diagnostic write did not land stays blocked in that process.

An older host that does not implement `promotions.recoverReward` now answers `{ status: 'pending' }` instead of throwing. That includes a protocol validator rejection reported as `AIT_BRIDGE_REQUEST_FAILED`, not only `UNSUPPORTED_METHOD`. `grantReward` is unchanged. A late promotion observer rejection is ignored and cannot reject the payout result.
