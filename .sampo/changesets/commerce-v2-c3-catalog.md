---
npm/@mpgd/catalog: minor
---

Commerce v2, PR C3: the sample `catalog.json` (version `2026-10-12`) names
Devvit SKUs (`platformProductIds.reddit`: `coins_100`, `coins_500`,
`remove_ads`), so the Reddit target's effective config lists those products
as configured and the Devvit webview and server derive the same product list
from them. Selling still needs the Devvit app's own opt-in
(`permissions.payments` and a matching `payments` block).
