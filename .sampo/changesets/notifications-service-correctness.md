---
npm/@mpgd/game-services: patch
---

Fix notifications v2 so a notice the game has recorded is not pushed, a cancel or replace does not drop a live delivery claim (which could send the same reminder twice), one provider's host-read failure does not fail every provider, and a reminder whose template data cannot fill its copy or a host-template mapping's own title and body is refused when it is set. An uncompilable link rule fails the set for every provider that would deliver the topic. Replacing a due reminder while its send is only claimed keeps the replacement pending until that claim settles, instead of marking it fired with no delivery.
