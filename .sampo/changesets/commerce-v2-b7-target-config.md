---
npm/@mpgd/target-config: minor
---

Commerce v2, PR B7: `TargetReleaseConfig.billingAuthority` is the optional
per-target commerce billing authority override (`store` or `host`, RFC
"Billing authority and memberships"). Absent, the RFC default applies
(`resolveCommerceBillingAuthority` from `@mpgd/platform/commerce-wallet`:
`web` and `web-preview` are `host`, every other profile `store`).
`validate:target-config` rejects `host` for the `google-play` and `app-store`
profiles.
