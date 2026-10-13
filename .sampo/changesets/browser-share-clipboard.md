---
npm/@mpgd/adapter-browser: minor
---

The web share clipboard fallback copies a link a paste can open. A
root-relative share link, such as `/daily`, used to be copied as is
(`Join me\n/daily`). It is now resolved against the explicit game page URL
(`locationHref`) first, then `document.baseURI` or the ambient location. Without
an HTTP(S) page to resolve it against, the share answers `unavailable`. Web Share
still receives the normalized route unchanged. Web sharing now reads its intent
through `withShareIntentCheck` from `@mpgd/platform/routes`, with the same rule
as before.

Clipboard bases carrying a username or password are rejected, so resolving a
root-relative link cannot copy URL credentials into a shared link.
