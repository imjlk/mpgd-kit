---
npm/@mpgd/catalog: minor (Added)
npm/@mpgd/target-config: minor (Changed)
---

Allow game-owned Reddit product SKUs in product catalogs, mark Devvit IAP as
target-supported, and gate commerce calls on the runtime IAP capability until
a payments adapter is installed. Devvit artifact smoke checks validate payment
endpoints and require products.json SKUs to match the effective game catalog.
