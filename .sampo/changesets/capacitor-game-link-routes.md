---
npm/@mpgd/platform: minor
npm/@mpgd/adapter-capacitor: minor
---

Game links a native app opens are checked with the shared route rule before
any router sees them.

- `NativeOpenUrlEvent` gains an optional `route`: for a game link, the path,
  query, and fragment of its URL, normalized with `normalizeRootRelativeRoute`
  from `@mpgd/platform/routes`. The URL's host is not part of it
  (`mygame://level/3` gives `/3`). The `LifecycleAdapter.onGameUrlOpen` and
  `NativeOpenUrlEvent` docs say a router that builds its route from anything
  else in the URL, such as a custom-scheme host, must check it with
  `normalizeRootRelativeRoute`.
- The Capacitor adapter discards a game link, cold or warm, whose path that
  rule refuses, such as `mygame://game//evil.example/x` or
  `https://game.example/%2F%2Fevil.example/x`. It also discards one with a
  control character or one that does not parse as a URL. A delivered game link
  carries its `route` (`/daily` for `mygame://game/daily`). A link with no path
  to check, such as `mygame://daily`, is delivered without one, and OAuth
  redirects are unchanged.
