---
npm/@mpgd/adapter-devvit: patch
---

Accept Devvit payment handler orders without `userId` again. Devvit's `PaymentHandlerRequest` (`@devvit/payments` 0.14) carries only `id`, `status`, `createdAt`, `updatedAt`, `products` and `metadata`, and Devvit runs the handler in the purchasing user's request context. Since 0.9.13, `normalizeDevvitFulfillmentOrder` and `normalizeDevvitRefundOrder` rejected every real order with `order.userId must be a string`, so no Reddit purchase could be fulfilled or refunded. The authenticated context player is again the binding. An order that does carry a `userId` must still be a string that matches it.
