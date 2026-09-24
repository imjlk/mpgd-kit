---
npm/@mpgd/bridge: minor
npm/@mpgd/platform: minor
npm/@mpgd/adapter-capacitor: minor
npm/@mpgd/capacitor-game-services: minor
---

Add a separate fail-closed credential storage contract to the Capacitor base
bridge. Android uses a Keystore-held AES-GCM key with no-backup ciphertext
files, and iOS uses device-only
Keychain items; neither falls back to ordinary game JSON storage.
