---
npm/@mpgd/capacitor-play-billing: minor (Added)
---

The Play Billing provider reports the Play sheet (`CommerceProvider.presentation`). The native plugin observes it from the activity lifecycle, never from `onPurchasesUpdated`: `open` when the Billing Library's proxy activity is created during the flow, `closed` when the game's activity resumes after it (`interrupted` on teardown), `not-started` when the flow ended without it. Facts arrive as `purchasePresentation` events and in the `purchase` answer's `presentation`; `getPresentationSupport` declares them.

On by default (`purchasePresentation: false` keeps the result-based pause). A web bundle on a native build from before the facts reports the store `configuration-required` and refuses new purchases with `CONFIGURATION_REQUIRED` / `PLAY_BILLING_PRESENTATION_UNSUPPORTED` instead of opening a sheet the game would wait on; recovery is unaffected. An adapter from before the facts sends no presentation id, and purchases run as before. Rebuild the app (`cap sync`) with this version's native code.
