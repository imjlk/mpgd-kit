---
npm/@mpgd/platform: patch (Fixed)
---

`@mpgd/platform/notifications-runtime` fixes three deferred notification issues:

- Reads back off a registration that keeps failing. A read retried a failed registration (a first one, one for another session, or a stale one) on every read, so a game that reads often sent a registration to a backend that kept refusing it on each read. A read now retries no sooner than 30 seconds after the failure, doubling with each failure in a row up to an hour. Start, a sign-in, `register()`, and a changed address or permission still send at once, and a registration the backend acknowledges ends the backoff.
- A registry entry that cannot be compared no longer breaks the start. An entry `loadRegistryEntry` answers whose compared fields (`provider`, `addressing`, `content`, `purposes`, `permission`) are malformed, or cannot be read, is a failed load: it is reported through `onError`, the runtime runs without the comparison, and the next `start()` loads it again. A malformed `registryEntry` given at creation is reported at each start and left out, as if none was given. Fields the runtime does not compare are not checked, so an entry from a newer backend still compares.
- `notificationRuntimeStateOf` reads each stored entry on its own: a malformed or unreadable one (a getter or `Proxy` trap that throws) is left out and the others are kept, and it never throws. The kept registration is a plain copy.

A storage or input failure whose thrown value cannot be read (a getter, `toString`, or `Proxy` trap that throws) now still surfaces as the runtime's `NotificationError`, with `a failure that cannot be read` in its message, instead of the raw value.
