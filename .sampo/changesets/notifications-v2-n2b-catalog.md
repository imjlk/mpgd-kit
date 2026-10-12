---
npm/@mpgd/catalog: minor
---

`@mpgd/catalog` makes the topic catalog's `notices` block `{ topic, copy }`.
`notices.copy` maps each locale to a title and a body per notice variant
(`consent-result.advertising.granted`, `consent-result.advertising.withdrawn`,
`consent-result.night.granted`, `consent-result.night.withdrawn`,
`reconfirmation.advertising`, and `reconfirmation.night`), filled only with
`{{consentDate}}`, and the notice topic keeps only the delivery settings.
`validateNotificationTopicCatalog` reports a notice topic that declares `copy`
or the `local` channel, carries a title or body in a mapping, or maps to a
provider that sends a host template or its mapping's own text; a missing
`notices.copy`, or one without the default locale; a locale without one of the
variants, an unknown variant, a blank title or body, and any other
placeholder. These replace the rule that the notice topic's own text use only
`{{consentDate}}`, and the free-form text rule no longer asks the notice topic
for copy. Breaking for 0.x: a catalog that declared a notice topic with copy
moves that text into `notices.copy`, one entry per variant.
