---
npm/@mpgd/catalog: minor
---

`@mpgd/catalog` makes the topic catalog's `notices` block `{ topic, copy }`.
`notices.copy` maps each locale to a title and a body per notice variant
(`consent-result.advertising.granted`, `consent-result.advertising.withdrawn`,
`consent-result.night.granted`, `consent-result.night.withdrawn`,
`reconfirmation.advertising`, and `reconfirmation.night`), filled only with
`{{consentDate}}`, which each variant uses, and the notice topic keeps only
the delivery settings. A backend takes the whole block as its one notice
setting. `validateNotificationTopicCatalog` reports a notice topic that
declares `copy` or the `local` channel, carries a title or body in a mapping,
even one alone, or maps to a provider that sends a host template or its
mapping's own text; and, by the platform's `notificationNoticeCopyIssues`, a
missing `notices.copy`, or one without the default locale; a locale without
one of the variants, an unknown variant, a blank title or body, a variant
without `{{consentDate}}`, any other placeholder, and a brace outside one.
Under the Korean rules it reports an advertising topic mapped to a provider
that sends its mapping's own text, which cannot carry the notice topic, once,
at that mapping. Issue paths spell locale and variant keys in brackets, shape
issues name the public types, and an undefined `notices.copy` entry or target
mapping is an issue rather than an exception. These replace the rule that the
notice topic's own text use only `{{consentDate}}`, and the free-form text
rule no longer asks the notice topic for copy. A catalog that gave its notice topic its own copy moves that text
into `notices.copy`, one entry per variant; no released version had notice
topics, since they arrive in this same release.
