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
a topic's copy. `NotificationNoticeSettings` is the catalog's whole `notices`
block, `{ topic, copy }`, the one notice setting a backend takes, and
`notificationNoticeCopyIssues` holds the rules its copy follows wherever it is
read: the default locale, every variant in every locale, no blank title or
body, `{{consentDate}}` in each variant, and no other placeholder or brace
outside one, as `readNotificationTemplate` reads a text the way
`fillNotificationTemplate` fills it. The conformance fake backend takes the
`notices` block, refuses copy that breaks those rules, and pushes each notice
in its variant, filled with `{{consentDate}}`, through `notices.topic`.
Vectors gain an optional `notices` block, `{ topic, copy }`, which the loader
checks by the same rules, `advertising-notices` moves its notice text there,
and the new
`advertising-notice-variants` vector checks the withdrawal and night variants;
all forty vectors pass.
