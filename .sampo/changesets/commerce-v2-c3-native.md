---
npm/@mpgd/capacitor-play-billing: patch
npm/@mpgd/capacitor-storekit: patch
---

Commerce v2, PR C3: a shell without the native plugin is a configuration
problem, not an outage. Capacitor's `UNIMPLEMENTED` answer (the plugin's
native code is not in the shell) now makes `getAvailability()` report
`configuration-required` instead of `temporarily-unavailable`, so a generated
game that registers the store provider before `mpgd target init capacitor
--providers` installed the plugin runs and opens no purchase UI.
