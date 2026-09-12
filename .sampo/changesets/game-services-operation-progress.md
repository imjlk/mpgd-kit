---
npm/@mpgd/game-services: minor (Added)
---

Expose optional, invocation-scoped purchase and rewarded-ad progress observers through the client entrypoint. Report actual platform and backend request/result stages without exposing evidence or changing grants, pending results, authoritative completion, or observer-free calls. Isolate observer exceptions and promise rejections from business results.

Repair extensionless internal imports and re-exports so every existing game-services public entrypoint loads directly in Node ESM, and validate those compiled entrypoints during tests.

Expose a DOM-free operations type entrypoint for headless service consumers.
