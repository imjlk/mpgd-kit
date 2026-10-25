---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

Ads declarations for store releases. `mpgd legal build` serves `app-ads.txt` at the legal site's root: a game-owned `legal/app-ads.txt` verbatim, or Google's AdMob line for `ads.admob.publisherId` in `mpgd.game.json` (`mpgd legal check` covers it too). `mpgd target init capacitor` declares `com.google.android.gms.permission.AD_ID` in a newly generated Android project when the shell installs `@capacitor-community/admob` and removes it from the merged manifest otherwise. A native build fails in `production` when a shell with AdMob lacks the Android `com.google.android.gms.ads.APPLICATION_ID` meta-data or the iOS `GADApplicationIdentifier` (the SDK stops the app at launch), and warns about a missing `SKAdNetworkItems` entry for Google or an advertising ID permission that does not match the shell.
