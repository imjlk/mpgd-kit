---
npm/@mpgd/cli: patch (Changed)
npm/@mpgd/create-game: patch (Changed)
---

Generated games ignore signing and store credentials: `*.p12`, `*.p8`, `*.mobileprovision`, `*.provisionprofile`, `*.keystore`, `*.jks` and `*.pepk`. `google-services.json` and `GoogleService-Info.plist` stay committed on purpose: Firebase documents them as non-secret, and `mpgd deploy run` builds from a pinned Git checkout that needs them.
