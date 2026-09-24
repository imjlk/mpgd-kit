---
npm/@mpgd/platform: minor (Added)
npm/@mpgd/target-config: minor (Added)
npm/@mpgd/adapter-capacitor: minor (Added)
npm/@mpgd/capacitor-game-services: patch (Fixed)
npm/@mpgd/cli: patch (Fixed)
---

Add optional Capacitor provider composition with per-method bridge validation and
fail-closed readiness reporting. Distinguish uninstalled, unconfigured,
action-required, transient, and available features without changing existing
purchase result states. Expose subscription and native/remote leaderboard
availability separately while preserving legacy target configuration defaults.
Fix the base plugin's ESM-relative export so the published tarball can be
imported by Node-based consumers and native build tooling.
Keep generated starter target-availability checks aligned with the new readiness states.
