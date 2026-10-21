---
npm/@mpgd/capacitor-storekit: patch
---

Keep a finished App Store durable listed so a finish that raced the ledger grant can still be verified, and finish a transaction only when its app account token matches the session. `commerce.v2.finishTransaction` uses that same check. A forged ledger entry id paired with a token read from the plugin is still not a signed server finish capability.
