---
npm/@mpgd/adapter-ait: minor (Added)
npm/@mpgd/target-config: minor (Changed)
npm/@mpgd/cli: minor (Added)
---

Add a reusable Apps in Toss production host bridge backed by the official game identity,
Storage, Ads 2.0, sharing, lifecycle, and Game Center APIs. Rewarded ads load before display and
forward callback evidence without issuing demo grants, while commerce stays fail-closed until a
game installs its own verified purchase flow.

Allow game targets to opt out of authoritative game services. Opted-out targets disable IAP and
ad features in their effective configuration and no longer require a production backend URL,
while targets that enable authoritative grants keep the public HTTPS backend release gate.
