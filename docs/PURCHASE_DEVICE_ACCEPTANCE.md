# Purchase device acceptance (Google Play and the App Store)

**Manual checklist.** Run it on real devices before every store release that
changes the native shell, a store plugin, `@mpgd/adapter-capacitor`,
`@mpgd/game-runtime`, or the purchase backend. The kit's tests use fakes and
JVM/XCTest doubles; none of the items below has been run by the kit on a
device. Record your own results (see [Recording results](#recording-results)).
It is step 9 of the [mobile launch checklist](./MOBILE_LAUNCH_CHECKLIST.md#9-before-you-press-release).

What it checks: the store sheet facts (`open`, `closed`, `not-started`,
`unknown`) that the Play Billing and StoreKit plugins report
([Play](https://github.com/imjlk/mpgd-kit/blob/main/native-plugins/capacitor-play-billing/README.md#purchase-sheet-facts),
[StoreKit](https://github.com/imjlk/mpgd-kit/blob/main/native-plugins/capacitor-storekit/README.md#purchase-sheet-facts),
[adapter](https://github.com/imjlk/mpgd-kit/blob/main/adapters/capacitor/README.md#store-sheet-facts))
match what is on screen, so the game pauses from the purchase request until
the sheet is gone and **never resumes under a sheet**; that grants come only
from the backend ledger; and that another player's purchase on the same
device is not granted to the current player.

Store facts below were checked on 2026-10-29 against
[Test Google Play Billing Library integration](https://developer.android.com/google/play/billing/test),
[Testing Ask to Buy in Xcode](https://developer.apple.com/documentation/storekit/testing-ask-to-buy-in-xcode)
and [Testing In-App Purchases with sandbox](https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox).

## Before you start

- [ ] Play: a license tester account on the device (the account that
      installed the app makes the purchase), the latest Play Store app, and a
      build whose package name matches the Play app. Google lets license
      testers sideload debug-signed builds for this, and offers the test
      instruments used below ("Test instrument, always approves", "Slow test
      card, approves after a few minutes", "Slow test card, declines after a
      few minutes").
- [ ] App Store: a Sandbox Apple Account signed in under Settings, and a build
      from Xcode or TestFlight (both use the sandbox). Ask to Buy is tested
      with a StoreKit configuration file in Xcode (below); the sandbox
      documentation describes no Ask to Buy switch.
- [ ] The backend you will release against (the production Worker accepts
      sandbox purchases only with `sandboxPurchases: { mode: 'grant', ... }`;
      [App Review and TestFlight purchases](./GAME_SERVICES_BACKEND.md#app-review-and-testflight-purchases-on-a-production-backend)).
- [ ] A way to see the facts. In a debuggable build, add a temporary listener
      next to `createGamePlatformRuntime` (`src/main.ts` in a generated game)
      and remove it before release. Log the facts from the gateway you pass to
      the runtime (`platform` there), not from `runtime.gateway`: the
      runtime's coordinated provider renumbers them and drops their `reason`.

      ```ts
      // Temporary acceptance logging; do not ship.
      platform.commerce?.presentation?.subscribe((fact) => console.info('[sheet]', JSON.stringify(fact)));
      runtime.execution.subscribe((snapshot) => console.info('[blocks]', snapshot.blocks.map((block) => block.reason).join(',')));
      runtime.gateway.lifecycle.onPause(() => console.info('[lifecycle] pause'));
      runtime.gateway.lifecycle.onResume(() => console.info('[lifecycle] resume'));
      ```

      Read it with Chrome remote debugging (`chrome://inspect`) on Android or
      Safari Web Inspector on iOS. On Android, `adb logcat` also shows the
      Play Billing activity starting
      (`com.android.billingclient.api.ProxyBillingActivity` or `...V2`) and
      the plugin's own warnings (tag `CapacitorPlayBilling`).
- [ ] Something that shows the game is running: an animation, a timer or
      music. While the game is paused nothing moves and no game audio plays.

## What every purchase must show

For each scenario except the `purchasePresentation: false` fallback at the
end of the stale-native-build item, the purchase's idempotency key gets:

| Signal | Expected |
| --- | --- |
| `[lifecycle]` | `pause` at the purchase request; `resume` only after the sheet's `closed` (or `not-started`), never while any store UI is visible |
| `[sheet]` | `open` when the sheet appears, then exactly one `closed`; `not-started` only when no sheet appeared; `unknown` only when the store call answered before the plugin observed anything (a call timeout), and a verdict must follow it |
| `[sheet]` `reason` | absent on a `closed` the plugin observed; `timeout` (15 minutes), `interrupted` (the activity finished) or `disposed` mean no native observation and are a finding unless the scenario says so |
| `[blocks]` | `game-runtime:lifecycle` and `presentation:purchase` from the request until `closed`; in a game without an ad provider, also `action:purchase` until the backend answers when the purchase runs through `runtime.actions` |
| Screen | the game is frozen (no animation, no game audio, taps do not reach gameplay) from the request until the sheet is gone, then resumes once |
| Grant | only after the backend verified the purchase (ledger entry, balance from the server); never from the sheet closing or the store result |

A game with an ad provider shows the same signals except `action:purchase`
(its actions rely on the purchase lease instead), and an ad must not start
while the purchase holds `presentation:purchase`.

## Google Play

- [ ] **Cancel with the sheet's close control.** Open the shop, buy, close the
      sheet. Expect `open`, `closed`, then `resume`; the purchase answers
      cancelled; no grant; buying the same product again opens a new sheet.
- [ ] **Cancel with the back button (or back gesture).** As above, dismissing
      with back. Same expectations.
- [ ] **Completed purchase.** Pay with "Test instrument, always approves".
      Expect `open`, `closed` after the sheet (including its confirmation)
      is gone, one grant from the ledger, and the purchase acknowledged or
      consumed by the backend (it no longer appears as unfinished on the next
      launch).
- [ ] **Pending purchase.** Pay with "Slow test card, approves after a few
      minutes". Expect `closed` when the sheet goes away (a pending purchase
      does not keep the game paused), the action result `pending`, no grant
      yet; after a few minutes (restart the app if needed) exactly one grant.
      Repeat with "Slow test card, declines after a few minutes": no grant,
      also after a restart.
- [ ] **Backgrounded with the sheet up.** Open the sheet, press Home, wait,
      return to the app. If the sheet is still there, the game stays paused
      until it is dismissed; if the game's screen comes back without it,
      `closed` arrives then. Never `resume` while the sheet is visible.
- [ ] **Rotation with the sheet up.** Open the sheet, rotate the device (and
      fold/unfold a foldable). The activity is not recreated (the shell's
      `android:configChanges`), no `closed` or `interrupted` arrives from the
      rotation, and the game stays paused until the sheet is dismissed.
- [ ] **Stale native build.** Only for a game whose web bundle can run on an
      older native build (a live update, or a shell that was not synced):
      install a native build from before the sheet facts (an older release
      of the shell) with the current web bundle. Expect the store to read
      `configuration-required`: the shop sells nothing, no purchase record or
      idempotency key is spent, and a purchase that still gets through is
      refused `CONFIGURATION_REQUIRED` / `PLAY_BILLING_PRESENTATION_UNSUPPORTED`
      without a sheet. Restore Purchases and the recovery of unfinished
      purchases still work. Then set `purchasePresentation: false` on
      `createCapacitorPlayBillingServiceProvider` and rebuild the web bundle:
      purchases work again with the earlier result-based pause (bounded by
      `launchedPurchaseActivityTimeoutMs`, 2 minutes), which can resume under
      a sheet left open longer than that. That fallback logs no `[sheet]`
      facts and holds no `presentation:purchase` block (unless the game passes
      its own `purchasePresentation` source), so the table above does not
      apply to it. Ship the rebuilt native shell instead whenever you can.

## App Store (StoreKit)

Apple documents that `purchase(options:)` displays the confirmation sheet and
returns a result, not that it returns only once every sheet is gone, so these
items are where `closed` is checked against the screen.

- [ ] **Cancel.** Open the sheet, cancel. Expect `open`, `closed` after the
      sheet is gone, `resume`; no grant.
- [ ] **Completed purchase.** Buy with the sandbox account. Expect one grant
      from the ledger. Watch the system's confirmation after payment: if
      `closed` and `resume` arrive while a purchase confirmation is still on
      screen, record it as a finding (the game resumes under it).
- [ ] **Ask to Buy.** In Xcode, enable Ask to Buy in the StoreKit
      configuration's purchase options and run the app with that
      configuration. Buy: the request goes to the parent, the purchase
      answers pending, `closed` arrives when the sheet is gone, and the game
      resumes with no grant. Approve, then decline, a request in the StoreKit
      transaction manager: approval delivers the transaction through
      `transactionUpdated`, a decline delivers nothing. Transactions signed
      by Xcode's local StoreKit testing do not verify against the App Store
      backend, so this item checks the pause and the absence of a grant, not
      the grant after approval.
- [ ] **Backgrounded with the sheet up.** Open the sheet, go to the Home
      Screen, return. The game stays paused while the sheet is up; `closed`
      arrives only when the purchase call ends.
- [ ] **iPad form sheet.** On an iPad, in both orientations, open the sheet:
      it shows as a form sheet with the game visible around it. The visible
      game is frozen and silent, taps outside the sheet do not reach
      gameplay, and rotating with the sheet up keeps the game paused until
      the sheet is gone.

## Another account's purchase

The backend answers another player's purchase as
[another account's purchase](./GAME_SERVICES_BACKEND.md#another-accounts-purchase)
(HTTP 409 `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT`, nothing granted or recorded),
and the reconciler parks the record and leaves its key to the owner
([RFC](./specs/commerce/commerce-v2-rfc.md#another-account)). You need two
server players you can switch between on one device. The kit's guest
identity cannot return to player A after a logout (a new guest replaces
it), so step 4 needs account sign-in in the game or a debug build hook of
your own that restores A's session; the kit ships neither. Without one, run
steps 1 to 3 only and note that step 4 was not run. Run it on both stores, with a consumable (a restored non-consumable
is shared by design under the default restore sharing policy).

- [ ] **1. Buy as A, unverified.** As player A, buy a consumable and cut the
      network right after the sheet closes (or block the game-services
      Worker), so the purchase stays unverified on the device. Finish the
      remaining steps within three days: Play refunds a purchase that is not
      acknowledged by then.
- [ ] **2. Switch to B.** Sign in as player B on the same device, back
      online. B gets no grant: B's balance does not change and the ledger has
      no entry for B. Either the client never sends A's purchase, or the
      Worker answers 409 `PURCHASE_BOUND_TO_ANOTHER_ACCOUNT` and the
      reconciler reports an `another-account` event (`onEvent`), not a
      failure. B can still buy the same product (no `IN_PROGRESS`).
- [ ] **3. Restore as B.** B taps Restore Purchases: still no grant for B.
- [ ] **4. Back to A.** Switch back to player A. A's startup recovery, or
      Restore Purchases, verifies the purchase and grants it to A exactly
      once; the purchase is then finished (acknowledged or consumed) and no
      longer listed as unfinished.

## Recording results

Keep one row per item, device and build in the release notes or the release
PR; an item that was not run says so.

| Item | Device, OS | Build (version, native shell) | Result | Notes (signals seen) |
| --- | --- | --- | --- | --- |
| Play: cancel (close control) | | | | |
