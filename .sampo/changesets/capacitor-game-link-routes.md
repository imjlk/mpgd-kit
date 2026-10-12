---
npm/@mpgd/platform: minor
npm/@mpgd/adapter-capacitor: minor
---

Game links a native app opens are checked with the shared route rule before
any router sees them.

- `NativeOpenUrlEvent` gains an optional `route`: for a game link, the path,
  query, and fragment of its URL, normalized with `normalizeRootRelativeRoute`
  from `@mpgd/platform/routes`. The `LifecycleAdapter.onGameUrlOpen` and
  `NativeOpenUrlEvent` docs say where a router must check a route it reads
  from the URL itself.
- The Capacitor adapter discards a game link, cold or warm, whose path that
  rule refuses, such as `mygame://game//evil.example/x` or
  `https://game.example/%2F%2Fevil.example/x`. It also discards one with a
  control character or one that does not parse as a URL. A delivered game link
  carries its `route` (`/daily` for `mygame://game/daily`). A link with no path
  to check, such as `mygame://daily`, is delivered without one, and OAuth
  redirects are unchanged.
