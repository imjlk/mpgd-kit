---
npm/@mpgd/platform: minor
---

Commerce v2, PR C2: the provider capabilities endpoint shape.

`@mpgd/platform/commerce` adds `CommerceServiceCapabilities` and
`CommerceServiceStoreCapabilities` (RFC "Provider capabilities endpoint"): the
protocol version a backend speaks and, per store its evidence registry
accepts, the evidence schemas, the finish owner, and the purchase kinds. They
are typia-validated (`assertCommerceServiceCapabilities`,
`isCommerceServiceCapabilities`) and published as
`docs/specs/commerce/schemas/commerce-service-capabilities.schema.json`, which
`validate:commerce-alignment` keeps in step with the types.
