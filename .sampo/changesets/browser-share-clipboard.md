---
npm/@mpgd/adapter-browser: patch
---

The web share clipboard fallback copies a link a paste can open. A
root-relative share link, such as `/daily`, used to be copied as is
(`Join me\n/daily`). It is now resolved against `document.baseURI`, or against
the page URL when there is no document, as Web Share resolves it. Without an
HTTP(S) page to resolve it against, the share answers `unavailable`. Web Share
still receives the normalized route unchanged. Web sharing now reads its intent
through `withShareIntentCheck` from `@mpgd/platform/routes`, with the same rule
as before.
