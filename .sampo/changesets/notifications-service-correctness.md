---
npm/@mpgd/game-services: patch
---

Fix notifications v2 so a notice the game has recorded is not pushed, a cancel or replace does not drop a live delivery claim (which could send the same reminder twice), one provider's host-read failure does not fail every provider, and a reminder whose template data cannot fill its copy is refused when it is set.
