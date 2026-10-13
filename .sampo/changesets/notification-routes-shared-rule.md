---
npm/@mpgd/platform: minor
npm/@mpgd/catalog: minor
---

`isRootRelativeNotificationRoute` now accepts a route only when it is at most
2,048 characters and `normalizeRootRelativeRoute(route) === route`, the rule
share links and v1 notification deep links follow, instead of its own copy.
Topic `route` and `optOutRoute` in a catalog, a local reminder's `route`, and
the route a router opens all follow it.

Root-relative normalization uses string operations, so catalog and notification
policy validation works in runtimes without the DOM `URL` constructor.

- A route that is not already in its normalized form is refused, and the
  catalog issue and the thrown error name that form. Examples are `/é`
  (`/%C3%A9`), `/a b` (`/a%20b`), a backslash in the path, and an empty `?` or
  `#` (`/a?`). A local reminder whose route is built at run time, such as
  `/?name=Ada Lovelace`, now throws until the game writes it in that form
  (`/?name=Ada%20Lovelace`).
- Escapes that stay on the game's origin once decoded are no longer refused,
  because no client can read them as another host. Examples are
  `/levels/%252e%252e`, `/a/%2E%2E%2Fb`, `/a/%09b`, a malformed escape such as
  `/50%`, and a backslash in the query or fragment. A route a client could read
  as another host is still refused.
