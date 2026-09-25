---
npm/@mpgd/cli: minor
---

Add a game-owned Kit dependency upgrade planner that resolves each public Kit
package's npm latest tag, checks declared peer compatibility, and can update
configured target manifests and pnpm lockfiles with rollback on failure.
