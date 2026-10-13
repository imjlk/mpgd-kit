---
npm/@mpgd/cli: minor
---

BREAKING: Commerce v2, PR C4: the generated game template (and the private
starter it mirrors) follows the removal of the commerce v1 surface. A game
created or upgraded with this release builds against `gateway.commerce` (the
renamed `commerceV2`) and the required `commerce` capability block.

- The Microsoft Store build gateway's purchase authority no longer declares
  `getEntitlements()`; entitlements come from the backend ledger through
  game-services.
- The Verse8 build gateway no longer passes `loadEntitlements`, and the
  game-owned `StarterVerse8Agent8Client` port lost `getCommerceSnapshot()`;
  only `listPurchases()` is read.
- The Apps in Toss wrapper (`apps/target-ait`) no longer passes the removed
  `readIapEntitlements` host option, and the Devvit server bridge
  (`apps/target-devvit/src/server/bridge.ts`) drops the `commerce.getEntitlements`
  case and the `nativeIap` capability key; its `runtime.getCapabilities` answer
  carries the `commerce` block.
- `pnpm validate:starter-workflow` fails a starter or template that names a
  removed v1 commerce API (`nativeIap`, `getEntitlements`,
  `createMicrosoftStoreCommerceAdapter`, ...).
