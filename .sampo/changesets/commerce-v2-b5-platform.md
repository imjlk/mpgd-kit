---
npm/@mpgd/platform: minor
---

Commerce v2, PR B5: `@mpgd/platform/commerce-conformance` lets a store actor
declare the token it reports for a fixture purchase.

`CommerceConformanceStoreActor.tokenOf?(purchase)` names the `token` the
provider under test reports for a scripted purchase when it is not the
fixture's own, for example a host-order store that reports the transaction id
(RFC "Client contract"). An adaptive run replays the fixture purchases with
that token into the reference store (`withStoreTokens`, now exported), so the
derived `verifyRequests` carry the token the provider reports instead of the
fixture's. Actors without the hook keep the fixture token; the committed
vectors and the reference harness are unchanged.
