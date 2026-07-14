---
npm/@mpgd/game-services: patch (Fixed)
---

Reject calendar-impossible UTC timestamps in server-driven platform fulfillment
and refund orders instead of accepting `Date.parse` overflow normalization.
