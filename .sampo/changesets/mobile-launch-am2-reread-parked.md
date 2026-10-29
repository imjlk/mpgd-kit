---
npm/@mpgd/game-services: patch (Fixed)
---

Restore Purchases reads a parked another-account record from the journal again before it resends it. A journal that bounds parked records (the starter journal now does) may drop one that a running reconciler still holds in memory; the resend then failed the pass with a journal write error. A record the journal no longer holds for the player is forgotten, and the store's report is matched as a purchase the journal does not know: a new record under its derived key, sent as a restore.
