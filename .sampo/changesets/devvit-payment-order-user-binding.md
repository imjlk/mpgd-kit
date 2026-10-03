---
npm/@mpgd/adapter-devvit: patch
---

Require `userId` on Devvit payment orders in `normalizeDevvitFulfillmentOrder` and `normalizeDevvitRefundOrder`. Orders that omit the purchasing user are now rejected instead of being stamped with the authenticated context player, so the order-to-player binding is always enforced before fulfillment or refund.
