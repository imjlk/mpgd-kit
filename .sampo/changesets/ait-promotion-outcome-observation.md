---
npm/@mpgd/adapter-ait: minor
---

Preserve bounded provider error codes and the pending dispatch marker after an explicit promotion failure. Add an optional best-effort outcome observer for authority diagnostics and successful receipt recording, including replay after host restart. Observation failure or timeout never changes payout success or permits retry; raw provider messages are not persisted or forwarded.
