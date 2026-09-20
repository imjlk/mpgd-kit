---
npm/@mpgd/phaser-assets: patch
---

Measure the whole pack-preparation budget on one monotonic clock
(`performance.now`) instead of `Date.now`, so a system clock correction
during `prepare` can no longer extend or prematurely exhaust the
`prepareTimeoutMs` budget. The decoder still receives only the unspent
remainder, now floored to its integer deadline contract so rounding can
never mint budget; no new archive request or decode starts once the
monotonic clock says the budget is spent, and a decode that resolves
after the budget is spent no longer earns staging handles. Existing
responsibilities are unchanged: `prepareTimeoutMs` still covers one
whole prepare, `requestTimeoutMs` still ends with each HTTP body, and
user-cancel, dispose and deadline causes stay distinct.
