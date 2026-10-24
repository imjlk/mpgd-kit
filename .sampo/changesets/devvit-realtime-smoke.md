---
npm/@mpgd/cli: patch
---

Allow an explicitly enabled Devvit Realtime permission during target artifact smoke checks. Preserve boolean validation, disabled defaults, and separate payment-readiness checks for custom multiplayer wrappers.

Allow an empty Devvit product catalog for historical order/refund callbacks when the effective target also exposes no enabled products. Continue requiring the products file, internal fulfillment/refund endpoints, IAP readiness, unique SKUs, and exact catalog agreement.
