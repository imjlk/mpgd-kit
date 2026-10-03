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
- `@mpgd/adapter-browser`: `createBrowserPlatformGateway()` never returns a
  grant on any code path. By default commerce and ads report unavailable and
  `purchase()` fails closed. The new `mockCommerce: true` option adds a
  local-demo sample catalog with evidence-only results: `purchase()` resolves
  `status: 'completed'` with a mock `transactionId`, empty `entitlementIds`,
  no `authoritativeGrant`, and `mpgd.browser.mock-purchase.v1` evidence;
  `showRewarded()` resolves `status: 'completed', rewardGranted: false` with
  no `ledgerEntryId` and `mpgd.browser.mock-reward.v1` evidence. Neither
  schema is accepted by backend claim APIs. The schema strings are exported as
  `browserMockPurchaseEvidenceSchema` and `browserMockRewardEvidenceSchema`.
  `withMicrosoftStoreCommerceAdapter` now replaces the base `ads` surface with
  an unavailable adapter and reports ad capabilities as false.
  `createUnavailableAdAdapter` is exported for custom gateways.
- `@mpgd/game-services`: `createGameServicesClient` forwards allow-listed
  client reward evidence (AdMob and Verse8) to `claimAdReward`, deriving
  `platformImpressionId` from the Verse8 evidence `requestId`. New exports:
  `isClientRewardEvidence`, `isVerse8ClientRewardEvidence`,
  `resolveRewardPlatformImpressionId`, `clientRewardEvidenceSchemas`,
  `verse8ClientRewardEvidenceSchema`. Recoverable monetization clients bind
  journaled Verse8 claims to the evidence-derived impression id.
