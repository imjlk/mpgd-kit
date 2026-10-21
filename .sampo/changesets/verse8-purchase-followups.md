---
npm/@mpgd/adapter-verse8: patch
---

Keep Verse8 purchase follow-up re-reads when a signal carries no new purchase id. An empty `purchases` list, or a list of ids already reported, still schedules re-reads at `verse8PurchaseFollowUpDelaysMs` until the Agent8 record appears. A signal that names a new purchase id still does not. The provider does not grant; it only re-reads the purchase source.
