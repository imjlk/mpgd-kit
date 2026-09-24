---
npm/@mpgd/capacitor-game-services: patch
npm/@mpgd/adapter-capacitor: patch
---

Stop returning demo purchase, ad reward, interstitial, and leaderboard successes from the reference native plugin when no real provider is installed. Report those capabilities as unavailable on Android and iOS, reject their operations with stable non-retryable codes, and preserve bridge error codes and retry hints in the Capacitor adapter.
