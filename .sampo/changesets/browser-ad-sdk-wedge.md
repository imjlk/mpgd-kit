---
npm/@mpgd/adapter-browser: patch
---

Stop a failed or hung ONE play or CrazyGames ad from wedging fullscreen occupancy and checkout for the page lifetime.

ONE play `showRewardedAsync` and `showInterstitialAsync` are bounded, including a synchronous throw from the show call. A rejection before an ad pause (`reason: "ad"`) releases the shared owner and does not grant; a background or payment pause is not evidence the ad opened. A show that never settles resolves pending with `rewardGranted: false`. If that call later settles, or the recovery bound expires with no terminal SDK result, the provider emits `closed` or `failed` so the runtime can release its fullscreen lease, still without `reward-earned` or a client grant. Dispose clears only the occupancy this gateway created, so another live gateway sharing the SDK keeps its ad or checkout lock. A checkout waiting on intent issuance does not open a payment sheet after that release. A settled unknown SDK reason still quarantines until a terminal result, the recovery bound, or dispose. A back handler that returns `true` or a thenable, including a Promise from another frame, consumes the synchronous ONE SDK back event so the host does not exit before the decision.

CrazyGames `requestAd` is bounded the same way as the AIT and Verse8 ad providers. A missed `adFinished` / `adError` resolves pending and quarantines as action-required until a later terminal callback. A synchronous throw does not guess that the ad closed. A proven not-started `adError` still releases immediately. Timeouts never grant.
