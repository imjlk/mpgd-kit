---
npm/@mpgd/adapter-ait: patch (Fixed)
npm/@mpgd/adapter-capacitor: patch (Fixed)
npm/@mpgd/adapter-devvit: patch (Fixed)
---

The notifications code that maps a failure reads a thrown value defensively, with the `@mpgd/bridge` thrown-value helpers: the Apps in Toss, Capacitor, and Devvit game-side bridge providers, the Devvit backend client, the Apps in Toss lazy bridge client, the Capacitor provider's token read, and the Devvit server's enqueue delivery and Redis store. A thrown value whose getter, `toString`, or `Proxy` trap throws no longer escapes the catch block: a field whose read throws counts as missing, so a readable notifications code and retryable flag are kept, and unreadable text reads `a failure that cannot be read`. On Devvit, an enqueue that throws such a value answers `ambiguous` as any other thrown enqueue does. A thrown object that is not an `Error` but has a string `message` now reports that message, where it used to read `[object Object]` (the Devvit enqueue report and the Apps in Toss lazy-load failure).
