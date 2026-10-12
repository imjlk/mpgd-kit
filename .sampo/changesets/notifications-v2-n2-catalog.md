---
npm/@mpgd/catalog: minor
---

`@mpgd/catalog` adds the notification topic catalog:
`NotificationTopicCatalog` types (`version`, `defaultLocale`, an optional
`notices.topic`, and topics with `id`, `purpose`, `channels`, `route`,
`optOutRoute`, `copy` per locale, optional `frequency`, `quietHours`, and
`deferrable`, and open-keyed `targets` mappings),
`validateNotificationTopicCatalog` and `assertNotificationTopicCatalog`, which
report every issue with its path: routes that stay on the game's origin and
never resolve to a protocol-relative path, an `optOutRoute` and no `local`
channel for advertising topics, the default locale in every `copy`, matched
without regard to case, a notice topic that is a declared remote `service`
topic, and, for targets with a provider registry entry, each mapping field's
rule (required, length, accepted values such as the Apps in Toss `agreement`,
and patterns such as the Devvit `link`, read with the `u` flag; a pattern that
does not compile is an issue, not an exception), no agreement only for
`service` templates and never on a per-send provider, a topic with the remote
channel only on providers whose purposes include its purpose, advertising only
on providers that deliver it as free-form content (with an expiry and the
opt-out action under the Korean rules), and the text a free-form provider
shows. Given the deployment settings, a catalog with an advertising topic
needs `advertisingRules`, and under the Korean rules the notice topic, a
deployment `noticeTopic` that names
it, and an advertising sender and opt-out line that the policy gate can use:
no blank contact, name, or opt-out line. It also re-exports
`isRootRelativeNotificationRoute` from `@mpgd/platform/notifications` and adds
`resolveNotificationTopicsForTarget`. The root `pnpm validate:notifications
[catalog] [deployment]` checks a catalog file against the reference Android,
iOS, Apps in Toss, and Devvit targets and the deployment settings file. The
kit ships no topic catalog of its own; the starter topics' purposes are still
undecided.
