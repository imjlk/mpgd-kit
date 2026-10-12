---
npm/@mpgd/game-services: patch
---

Notification delivery now rejects a root-relative deep link whose dot segments
collapse into a protocol-relative path. Before, `/.//other.example/path` (also
with `%2e` dot segments or a backslash) passed the same-origin check and
normalized to `//other.example/path`, which a client opens as a link to
another host.
