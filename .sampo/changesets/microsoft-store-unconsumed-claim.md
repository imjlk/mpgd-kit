---
npm/@mpgd/game-services: patch
---

An unconsumed Microsoft Store claim is no longer replaced when Collections returns a new modified date or item id, so one quantity-1 unit cannot be granted twice before consume. The verification id uses the Collections `transactionId` when present, and otherwise the collection item id; `modifiedDate` stays in the payload. A purchase already recorded under `microsoft-store:<storeId>:<itemId>:<modifiedDate>` keeps that ledger key on re-verify. A different provider purchase can be claimed only after the previous claim is released.
