---
npm/@mpgd/adapter-browser: patch
---

Stop a failed or hung ONE play or CrazyGames ad from wedging fullscreen occupancy and checkout for the page lifetime.

ONE play `showRewardedAsync` and `showInterstitialAsync` are bounded. A rejection before any host pause releases the shared owner and does not grant. A show that never settles resolves pending with `rewardGranted: false` and keeps occupancy only until a later terminal SDK result, a recovery bound, or `lifecycle.dispose()`. A settled unknown SDK reason still quarantines until dispose. A back handler that returns a Promise consumes the synchronous ONE SDK back event so the host does not exit before the decision.

CrazyGames `requestAd` is bounded the same way as the AIT and Verse8 ad providers. A missed `adFinished` / `adError` resolves pending and quarantines as action-required until a later terminal callback. A synchronous throw does not guess that the ad closed. A proven not-started `adError` still releases immediately. Timeouts never grant.
