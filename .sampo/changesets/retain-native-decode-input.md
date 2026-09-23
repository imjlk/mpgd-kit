---
npm/@mpgd/phaser-assets: patch
---

Retain image inputs until native decoding settles after cancellation or timeout, preventing rapid scene transitions from permanently blocking the decode queue while still rejecting cancelled callers promptly.
