---
npm/@mpgd/platform: patch
---

The capability conformance runner now rejects a provider that reuses an earlier snapshot after a transition or mutates the fixture's aliased expectation, even when later values appear to match.
