---
npm/@mpgd/cli: patch
---

Return an asset-pack delivery deadline failure even when a FIFO manifest reader remains blocked after stream destruction. Keep the timeout smoke writer owned by the test so its lifetime is deterministic in CI.
