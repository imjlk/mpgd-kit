---
npm/@mpgd/platform: minor
npm/@mpgd/adapter-ait: minor
npm/@mpgd/adapter-capacitor: minor
npm/@mpgd/adapter-devvit: minor
---

Every target whose host builds or receives a share URL now checks
`ShareIntent.deepLink` with one rule before the host sees the intent.

- `@mpgd/platform/routes` adds `normalizeShareLink(deepLink)`, the share-link
  rule web sharing already followed. A root-relative link becomes the route
  `normalizeRootRelativeRoute` returns. An absolute link must spell out
  `https://` or `http://`, carry no credentials, and keep a path no client
  reads as another host. Anything else answers `undefined`.
- `@mpgd/platform/routes` also adds `readShareIntent(intent)` and
  `withShareIntentCheck(sharing)`. The wrapper answers
  `{ status: 'unavailable' }` for an intent that is not an object, has no
  string `text`, or has a link the rule refuses, without calling the adapter.
  An accepted intent reaches the adapter with its link normalized. They stay
  out of the main entry, which headless consumers type-check without the
  `URL` global.
- `@mpgd/platform/share-link-conformance` adds `runShareLinkConformance`. It
  shares every vector in `rootRelativeRouteVectors` and the new
  `shareLinkVectors` (`@mpgd/platform/route-vectors`), plus malformed intents,
  through an adapter's `share`. It checks the answers and the link the host
  was handed, and it throws one error that lists every failure. Each adapter
  that maps share links runs it, and the root
  `pnpm validate:share-link-conformance` fails for an adapter that defines a
  share without running it. WeChat is listed as exempt: its share card carries
  no link, and mini-game runtimes have no `URL` global.
- The Capacitor and Devvit gateways wrap `sharing` with
  `withShareIntentCheck`. A link outside the contract, such as
  `mygame://invite`, `./daily`, or `/%2F%2Fevil.example/x`, now answers
  `unavailable` without reaching the native or server bridge, and the bridge
  receives the normalized link. Before, they passed every intent on as is.
- Apps in Toss reads links that are not `intoss://<app>` links with
  `normalizeShareLink` before reducing them to their path. It now also refuses
  `https:/daily`, `https:evil.example/x`, and links with credentials, which it
  used to reduce to a path.
