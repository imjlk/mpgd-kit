---
npm/@mpgd/adapter-ait: patch
---

Sharing on Apps in Toss now answers `unavailable` for a root-relative link
that names a host: a backslash right after the leading slash (`/\ x`,
`/\other.example/path`) or a control character (`/<tab>/host`). Before, `/\ x`
threw `TypeError: Invalid URL`, which the bridge reported as a retryable
request failure. A link naming the internal placeholder host was rewritten to
an `intoss://` path in the mini-app.
