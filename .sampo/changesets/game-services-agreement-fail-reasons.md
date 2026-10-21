---
npm/@mpgd/game-services: patch (Fixed)
---

`createAitFunctionalMessageDeliveryProvider` refuses an `agreementFailReasons` entry that is empty or longer than 1,024 characters once trimmed, with a `TypeError` at creation. The provider reads at most 1,024 characters of a `reachedFailReason`, so a longer entry could never match, and an empty one would have matched a blank reason as an agreement denial. A game-services Worker with such an `MPGD_AIT_NOTIFICATIONS` setting reports its notifications as misconfigured, as for any other invalid setting.
