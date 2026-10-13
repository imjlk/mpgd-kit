---
npm/@mpgd/platform: minor
---

`@mpgd/platform/notifications` gives consent notices one copy per variant, so
a result notice can say whether the player consented, refused, or withdrew,
and to advertising or to night sending (decree art. 62-2), and a
re-confirmation which consent it confirms (decree art. 62-3). It adds
`NotificationNoticeVariant` with `notificationNoticeVariants`, including the
two optional refusal variants, whose text falls back to the withdrawal's
(`notificationNoticeVariantFallbacks`); `NotificationNoticeCopy` (the
catalog's `notices.copy`: per locale, a `NotificationNoticeLocaleCopy` with a
title and a body per variant); and `notificationNoticeVariantCopy`, which
reads one variant's copy per locale as a topic's copy. A listed
`NotificationNotice` carries its `variant`, which `listNotificationNotices`
sets: a `withdrawn` record whose latest earlier record of its kind is not a
consent reports a refusal. The game shows that variant, the scheduler pushes
it, and `recordShown` still takes the listed notice as is.
`NotificationNoticeSettings` is the catalog's whole `notices` block,
`{ topic, copy }`, the one notice setting a backend takes, and
`notificationNoticeCopyIssues` holds the rules its copy follows wherever it is
read: the default locale, every required variant in every locale, no blank
title or body, `{{consentDate}}` in each variant, and no other placeholder or
brace outside one, as `readNotificationTemplate` reads a text the way
`fillNotificationTemplate` fills it. The conformance fake backend takes the
`notices` block, refuses copy that breaks those rules, and pushes each notice
in its listed variant, filled with `{{consentDate}}`, through
`notices.topic`. Vectors gain an optional `notices` block, `{ topic, copy }`,
which the loader checks by the same rules, and can expect a listed notice's
`variant`; `advertising-notices` moves its notice text there, and the new
`advertising-notice-variants` vector pushes both re-confirmations and every
kind of result notice, one refusal in its own text and one in the
withdrawal's.
