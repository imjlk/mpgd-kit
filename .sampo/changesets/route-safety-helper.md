---
npm/@mpgd/platform: minor
npm/@mpgd/adapter-ait: minor
npm/@mpgd/adapter-browser: minor
npm/@mpgd/game-services: patch
---

`@mpgd/platform/routes` exports one route-safety rule for links a game hands
to the kit, and `@mpgd/platform/route-vectors` exports the shared `normalized`
and `rejected` vectors that every package mapping such links runs:

- `normalizeRootRelativeRoute(input)` returns the path, query, and hash a
  root-relative link names on the game's origin. It answers `undefined` when a
  client could read the link as another host: a second slash or a backslash
  after the leading slash, a control character, or a path that begins with an
  empty segment after dot segments collapse. The same holds when the path is
  percent-decoded once and parsed again, with the path ending at any decoded
  `?` or `#` or keeping them all. A path with more than 16 decoded `?` and `#`
  is refused.
- `hasNetworkPathPrefix(pathname)` and `hasRouteControlCharacter(value)` are the
  checks it builds on. `hasNetworkPathPrefix` answers `true` for anything that
  is not a URL path.

Notification delivery in `@mpgd/game-services` and Apps in Toss sharing in
`@mpgd/adapter-ait` use this rule instead of their own copies. They now also
refuse a path that reaches another host when a decoded `?` or `#` stays in the
path instead of ending it, such as `/%3F%2F..%2F%2Fhost`, and a path with more
than 16 decoded `?` and `#`.

Web sharing in `@mpgd/adapter-browser` now follows the `ShareIntent.deepLink`
contract:

- A root-relative link is normalized and stays relative, so Web Share resolves
  it against the document as before.
- An absolute link must spell out `https://` or `http://`, carry no
  credentials, and keep a path no client can read as another host.
- It answers `unavailable` for anything else, including page-relative links
  (`./daily`, `?x=1`), `javascript:`, `data:`, and `intoss:` links, and a
  `text` or `deepLink` that is not a string. Before, it passed any string on.

The Apps in Toss sandbox bridge now reads share requests exactly as the host
bridge does:

- It answers `unavailable` for a request the host refuses, and
  `{ status: 'shared', completion: 'presented' }` otherwise. Before, it
  answered `{ status: 'shared' }` for any request, which reads as completed.
- A new optional `appName` option sets the app name `intoss://` links must
  carry. It defaults to `mpgd-kit`, as on the host.
