---
npm/@mpgd/platform: minor
---

Let the notifications conformance runner drive a backend under test: `runNotificationConformanceVector` accepts `createBackend`, which receives the inputs the fake backend would, and awaits `revokeSession` and `registerInstallation` when a backend finishes them asynchronously. A production notifications service can now pass the server vectors.
