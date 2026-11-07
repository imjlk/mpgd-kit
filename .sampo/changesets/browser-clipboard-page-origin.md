---
npm/@mpgd/adapter-browser: patch (Fixed)
---

The web share clipboard fallback no longer copies a link on another origin when the page's `<base>` points elsewhere, such as an asset CDN. A root-relative share link is now resolved against the page URL the gateway was given (`locationHref`), then the location, and only then the document base, for an embedded or `file:` page with no HTTP(S) URL. Web Share still receives the normalized route unchanged.
