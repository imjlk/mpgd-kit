---
npm/@mpgd/adapter-ait: patch
---

Sharing on Apps in Toss now answers `unavailable` for a share link that a
client could read as another host, and for any link that contains a control
character. A root-relative link with a backslash right after the leading
slash used to throw `TypeError: Invalid URL` (`/\ x`), which the bridge
reported as a retryable request failure, or was rewritten to an `intoss://`
path (`/\` followed by the internal placeholder host). The same rules now
apply to the path of root-relative, `https://`, and `intoss://` links, as
they do for notification deep links in `@mpgd/game-services`: a path that
begins with an empty segment directly (`//host`), after dot segments collapse
(`/.//host`), or once percent-decoded (`/%2F/host`, `/%09/host`) is refused.

An `intoss://` link is now read as the path it carries and rebuilt, and it
must start with exactly `intoss://<app>` followed by `/`, `?`, `#`, or
nothing. Before, the raw input was forwarded whenever URL parsing found the
app's host, so `intoss://other\@<app>/path`, which Android reads as the host
`other`, was shared unchanged. Links with a stray tab or newline, which URL
parsing used to drop silently, are now refused rather than shared.
