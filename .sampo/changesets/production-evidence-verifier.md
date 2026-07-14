---
npm/@mpgd/game-services: minor (Added)
npm/@mpgd/platform: minor (Added)
---

Added a provider-neutral purchase and rewarded-ad evidence verifier boundary,
versioned adapter evidence envelopes, explicit development verifier helpers,
bounded verifier execution, authority-level replay protection, and fail-closed
entitlement grants when production verification is unavailable. Idempotency
retries now reject changes to the original logical grant or platform target,
including raced writes, while existing stores can use the list fallback when
optional indexed idempotency or evidence lookups are not implemented.
