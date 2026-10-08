---
npm/@mpgd/game-services: minor (Added)
---

Add an optional Microsoft Store consumption receipt persistence hook before recovery ownership release. Validate provider order attribution and keep finalization pending when persistence fails. Expose missing retry order IDs explicitly so integrations can require an exact durable receipt instead of inventing refund attribution.
