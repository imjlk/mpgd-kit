---
npm/@mpgd/phaser-assets: patch
---

Acquire foreground ownership directly from the resident loader for a prefetched
warm pack. ZIP/mixed delivery callbacks now prepare cold acquisitions only, so
handover preserves independent leases without downloading or staging an already
decoded pack again.
