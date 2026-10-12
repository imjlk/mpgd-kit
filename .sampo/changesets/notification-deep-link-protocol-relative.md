---
npm/@mpgd/game-services: patch
---

Notification delivery now rejects deep links that a client could open on
another host. Before, a root-relative link whose dot segments collapse into a
leading `//`, such as `/.//other.example/path` (also with `%2e` dot segments),
passed the same-origin check and normalized to the protocol-relative
`//other.example/path`. Delivery now also rejects:

- every root-relative link with a backslash right after the leading slash.
  Most were already rejected, but one naming the internal placeholder host was
  rewritten to a same-origin path, and `/\ x` threw a raw `TypeError`;
- a path that would begin with an empty segment once percent-decoded, such as
  `/%2F/host`, `/%5Chost`, or `/%09/host`, in root-relative links and in
  absolute links on an allowed origin. A client that decodes once reads these
  as `//host`;
- an absolute link on an allowed origin whose path starts with `//`, such as
  `https://game.example//path`, which was accepted before;
- a link longer than 2,048 characters after normalization, so a normalized
  link always normalizes to itself.
