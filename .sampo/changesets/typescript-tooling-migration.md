---
npm/@mpgd/cli: minor (Added)
---

Add a preview-first TypeScript tooling migration for existing generated games, with JavaScript and TypeScript runner customization detection, stale-plan protection, rollback limited to migration-owned lockfile updates, and parent-workspace boundaries.

Block mixed child-package compiler versions and conflicting non-dev or peer
toolchain declarations; recheck nested manifests and workspace configuration
before applying a preview.

Preserve untouched and concurrently edited files during rollback. Record lock
ownership and explain safe manual recovery after an interrupted migration.
