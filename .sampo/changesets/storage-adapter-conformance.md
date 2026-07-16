---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/adapter-browser: minor (Added)
npm/@mpgd/adapter-verse8: patch (Fixed)
npm/@mpgd/adapter-devvit: patch (Fixed)
npm/@mpgd/cli: patch (Fixed)
---

Add reusable local and remote storage conformance checks, injectable browser
storage, and fail-closed persistence behavior across browser, native bridge,
Apps in Toss, Devvit, and Verse8 targets. Generated Devvit servers now reject
identity, provider, serialization, and quota failures without switching to a
browser fallback store.
