---
npm/@mpgd/platform: minor
npm/@mpgd/target-config: minor
npm/@mpgd/adapter-capacitor: minor
npm/@mpgd/capacitor-game-services: patch
npm/@mpgd/cli: patch
---

Add optional Capacitor provider composition with per-method bridge validation and
fail-closed readiness reporting. Distinguish uninstalled, unconfigured,
action-required, transient, and available features without changing existing
purchase result states. Expose subscription and native/remote leaderboard
availability separately while preserving legacy target configuration defaults.
Fix the base plugin's ESM-relative export so the published tarball can be
imported by Node-based consumers and native build tooling.
Keep generated starter target-availability checks aligned with the new readiness states.
