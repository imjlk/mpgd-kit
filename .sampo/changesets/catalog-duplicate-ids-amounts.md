---
npm/@mpgd/catalog: patch
---

`assertProductCatalog` and `assertAdPlacements` reject a repeated logical product or placement id. Platform-id collisions were already rejected; a second entry with the same id was kept by the first `find()` and could hide a different grant or SKU.

Currency grant amounts and ad reward amounts must be finite, greater than zero, and a safe integer. A continue reward is a count of continues, not a fraction. Resource grant amounts are unchanged.
