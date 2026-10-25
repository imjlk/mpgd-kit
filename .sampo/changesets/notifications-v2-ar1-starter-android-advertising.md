---
npm/@mpgd/cli: minor (Added)
npm/@mpgd/create-game: minor (Added)
---

Android advertising pushes in the notifications starter (AR1). `mpgd target init capacitor --providers notifications` declares the kit's advertising renderer (`dev.mpgd.capacitor.AdvertisingMessagingService`, with the `dev.mpgd.notifications.advertising_renderer` meta-data) as the shell's Firebase messaging service in a newly generated Android project and removes the one `@capacitor-firebase/messaging` declares; for an existing Android project it prints the manifest lines to add. It now also needs the game's `@mpgd/adapter-capacitor` to export `readCapacitorAdvertisingPushRenderer`. A game created with `--providers notifications` maps the sample `events` advertising topic to `android` too (channel `mpgd-advertising`), sets `shellRendersAdvertising: true` in `notifications/deployment.json`, and passes the renderer read to the Capacitor provider; the backend sends Android advertising only to installations whose shell registered the renderer. Existing games are unchanged.
