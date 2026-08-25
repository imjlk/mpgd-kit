---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/bridge: minor (Added)
npm/@mpgd/catalog: minor (Added)
npm/@mpgd/target-config: minor (Added)
npm/@mpgd/adapter-ait: minor (Added)
npm/@mpgd/cli: patch (Changed)
---

Add provider-neutral inline banner placements and surface lifecycle methods. Apps in Toss hosts now
initialize and attach Toss banner ads by game-owned surface ID, report rendered/no-fill/failure
states, and destroy active attachments on unmount. Target configuration, effective artifacts,
starter validation, and bridge contracts understand optional `bannerAds` capability flags while
remaining compatible with previously published adapters and target matrices.
