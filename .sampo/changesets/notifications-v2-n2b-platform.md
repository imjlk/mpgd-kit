---
npm/@mpgd/platform: minor
---

`@mpgd/platform/notifications` gives consent notices one copy per variant, so
a notice can say whether the player consented or withdrew, and to advertising
or to night sending, as decree art. 62-3 requires. It adds
`NotificationNoticeVariant` with `notificationNoticeVariants`,
`notificationNoticeVariant` (a notice's variant from its kind, its record's
kind, and the record's state), `NotificationNoticeCopy` (the catalog's
`notices.copy`: per locale, a title and a body per variant), and
`notificationNoticeVariantCopy`, which reads one variant's copy per locale as
a topic's copy. The conformance fake backend takes `noticeCopy` and pushes
each notice in its variant, filled with `{{consentDate}}`, through the notice
topic, and refuses a Korean-rules deployment whose declared notice topic
comes without `noticeCopy`. Vectors gain an optional `notices` block with that copy,
`advertising-notices` moves its notice text there, and the new
`advertising-notice-variants` vector checks the withdrawal and night variants;
all forty vectors pass.
