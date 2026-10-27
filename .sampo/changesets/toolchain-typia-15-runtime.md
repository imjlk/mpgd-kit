---
npm/@mpgd/analytics: patch (Changed)
npm/@mpgd/bridge: patch (Changed)
npm/@mpgd/target-config: patch (Changed)
---

The runtime `typia` dependency moves from 13.0.2 to 15.2.1, and the shipped validators are rebuilt with typia 15 through ttsc 0.34.2. A game that runs its own typia transform over these packages' types needs typia 15.2 or later. typia 15's `date-time` and `date` formats refuse a day the month does not have and a space for `T`, and its length tags count code points.
