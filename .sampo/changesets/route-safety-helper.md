---
npm/@mpgd/platform: minor
npm/@mpgd/adapter-ait: minor
npm/@mpgd/adapter-browser: patch
---

`@mpgd/platform/routes` exports one route-safety rule for links a game hands
to the kit, and `@mpgd/platform/route-vectors` exports the shared vectors that
every package mapping such links now runs:

- `normalizeRootRelativeRoute(input)` returns the path, query, and hash a
  root-relative link names on the game's origin. It answers `undefined` when a
  client could read the link as another host: a second slash or a backslash
  after the leading slash, a control character, or a path that begins with an
  empty segment after dot segments collapse or once percent-decoded and parsed
  again.
- `isCanonicalRootRelativeRoute(route)` accepts a route a project can declare,
  such as a notification topic's `route`. It must already be normalized and
  free of dot segments, backslashes, and control characters, as written and
  once percent-decoded.
- `hasNetworkPathPrefix(pathname)` and `hasRouteControlCharacter(value)` are the
  checks they build on. `hasNetworkPathPrefix` answers `true` for anything that
  is not a URL path.

Notification delivery in `@mpgd/game-services` and Apps in Toss sharing in
`@mpgd/adapter-ait` now use this rule instead of their own copies, with no
change in what they accept.

Two places that skipped the rule now apply it:

- Web sharing in `@mpgd/adapter-browser` resolves a relative link (`/daily`,
  `?challengeToken=…`, `./daily`) against the page, as Web Share does. When the
  page URL is known, it shares the result as an absolute URL, so the clipboard
  fallback copies a usable link. It answers `unavailable` for a relative link
  that could name another host, for an absolute link that is not HTTP(S)
  (`javascript:`, `data:`, `intoss:`), and for a `deepLink` that is not a
  string.
- The Apps in Toss sandbox bridge applies the host's share-link rules. It
  answers `unavailable` for a link the host refuses, and
  `{ status: 'shared', completion: 'presented' }` otherwise, as the host does.
  Before, it answered `{ status: 'shared' }` for any link, which reads as
  completed. A new optional `appName` option, validated like the host's, sets
  the app name `intoss://` links must carry. Without it, the sandbox accepts
  the plain app name a link names.
