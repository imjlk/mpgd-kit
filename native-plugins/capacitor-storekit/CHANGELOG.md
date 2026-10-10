# @mpgd/capacitor-storekit

## 0.1.9 — 2026-10-11

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.5, game-services@0.19.1, platform@0.18.0

## 0.1.8 — 2026-10-10

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.4

## 0.1.7 — 2026-10-10

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.3

## 0.1.6 — 2026-10-09

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.2, game-services@0.19.0, platform@0.17.0

## 0.1.5 — 2026-10-09

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.1, game-services@0.18.1, platform@0.16.0

## 0.1.4 — 2026-10-09

### Patch changes

- Updated dependencies: adapter-capacitor@0.7.0, bridge@0.11.0, game-services@0.18.0, platform@0.15.0

## 0.1.3 — 2026-10-04

### Patch changes

- Updated dependencies: adapter-capacitor@0.6.2, game-services@0.17.2

## 0.1.2 — 2026-10-04

### Patch changes

- [a5f74351](https://github.com/imjlk/mpgd-kit/commit/a5f74351f967fe68d887785403d6a86949dc08dc) Harden the Capacitor shell and StoreKit finish path. `mpgd target init capacitor` now opts a freshly generated Android project out of cloud backups and Android 12+ device-to-device transfers: it sets `android:allowBackup="false"`, `android:fullBackupContent="@xml/backup_rules"` and `android:dataExtractionRules="@xml/data_extraction_rules"` on the manifest and writes both rule resources, which exclude the `root`, `file`, `database`, `sharedpref` and `external` domains. Native target builds inject a restrictive Content-Security-Policy meta tag into the staged shell `index.html` unless the game page already declares an enforcing `Content-Security-Policy` meta tag (a report-only policy does not count). `finishGrantedTransaction` on the StoreKit provider only finishes a transaction with the ledger entry ID that `recoverStoreKitPurchases` recorded from a backend answer in the current session, consumes that pair before the native call so overlapping finishes share one native call, and restores it when the native finish fails. This binds finishing to the recovery flow and blocks arbitrary or accidental finish calls; it is not a trust boundary against code that controls the recovery backend object, where the server-side `recoverPurchase` verification remains the real control. — Thanks @imjlk!
- Updated dependencies: adapter-capacitor@0.6.1, game-services@0.17.1

## 0.1.1 — 2026-09-28

### Patch changes

- [ad66eaf0](https://github.com/imjlk/mpgd-kit/commit/ad66eaf0659b3fce6cacbcec609409479aea0985) Enable automated releases for the separately registered Play Billing and StoreKit Capacitor plugins. — Thanks @imjlk!
- Updated dependencies: adapter-capacitor@0.6.0, game-services@0.17.0, platform@0.14.0

