---
npm/@mpgd/platform: minor
npm/@mpgd/adapter-ait: minor
npm/@mpgd/cli: minor
---

Preserve provider-neutral platform operation codes and retry hints across adapter boundaries. Apps in Toss now uses the current anonymous identity API, coalesces concurrent identity reads for one wrapper session, retries a rejected identity read after the host recovers, and gives generated games an explicit native Sandbox wrapper command without local SDK or identity mocks.
