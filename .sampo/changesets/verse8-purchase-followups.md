---
npm/@mpgd/adapter-verse8: patch
---

Keep Verse8 purchase follow-up re-reads until every outstanding unsettled purchase signal has been settled. A signal that reports no new purchase id, including the id-less default dialog close, increments that count and opens or extends one follow-up window at `verse8PurchaseFollowUpDelaysMs`. Each purchase id newly reported by the immediate re-read or a follow-up read settles one outstanding signal. A signal that names a new purchase id settles that signal and does not consume an earlier slot or schedule re-reads. Timers cancel only when the count reaches 0, the window's attempts elapse, or the last listener unsubscribes. An id the bound has already emitted is not emitted again. The provider does not grant; it only re-reads the purchase source.
