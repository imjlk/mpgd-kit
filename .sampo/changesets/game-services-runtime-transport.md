---
npm/@mpgd/game-services: minor
---

Allow an HTTP JSON backend transport to be injected through
`createGameServicesRuntime` while preserving authoritative backend validation,
backend status handling, and per-request credential resolution. Keep oRPC on
its distinct Fetch-based path.
