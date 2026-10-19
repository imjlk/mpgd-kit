---
npm/@mpgd/adapter-ait: patch
---

Recover cached and authority-confirmed promotion receipts regardless of payout capability, retain markerless receipts, and consult the authority after storage read failure without inventing a dispatch timestamp. Preserve ambiguous SDK diagnostics across restarts and retain terminal receipts in a bounded bridge-local fallback when native storage fails. Recovery never authorizes a new payout.
