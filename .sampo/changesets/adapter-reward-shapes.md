---
npm/@mpgd/adapter-verse8: patch
npm/@mpgd/adapter-browser: patch
npm/@mpgd/game-services: patch
---

Stop client adapters from returning grant-shaped rewarded-ad results.

- `@mpgd/adapter-verse8`: a Verse8 `rewarded` SDK callback now resolves to
  `status: 'completed', rewardGranted: false` with the `verse8.ads.reward.v1`
  evidence envelope and no `ledgerEntryId`. The Verse8 `requestId` is an
  impression id, not a ledger entry; only the backend verifier may grant.
- `@mpgd/adapter-browser`: `createBrowserPlatformGateway()` no longer fabricates
  completed purchases or granted rewards by default. Commerce and ads report
  unavailable unless the new `mockCommerce: true` option is passed for local
  demos. `withMicrosoftStoreCommerceAdapter` now replaces the base `ads`
  surface with an unavailable adapter and reports ad capabilities as false.
  `createUnavailableAdAdapter` is exported for custom gateways.
- `@mpgd/game-services`: `createGameServicesClient` forwards allow-listed
  client reward evidence (AdMob and Verse8) to `claimAdReward`, deriving
  `platformImpressionId` from the Verse8 evidence `requestId`. New exports:
  `isClientRewardEvidence`, `isVerse8ClientRewardEvidence`,
  `resolveRewardPlatformImpressionId`, `clientRewardEvidenceSchemas`,
  `verse8ClientRewardEvidenceSchema`. Recoverable monetization clients bind
  journaled Verse8 claims to the evidence-derived impression id.
