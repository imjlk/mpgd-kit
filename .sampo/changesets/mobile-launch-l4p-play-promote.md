---
npm/@mpgd/cli: minor (Added)
---

`mpgd deploy promote --from <track> --to <track>` releases a Google Play build that is already on one track on another track with `edits.tracks.update`, uploading nothing, so the build that passed closed testing is the one that reaches production. It promotes the whole source release containing `--version-code` (refused unless that version is on the source track), or the source track's only completed release, takes `--status draft|completed|inProgress`, `--user-fraction` and `--release-notes` (the source release's notes by default), refuses draft and halted sources, needs `--approve` and, for a production target or a staged rollout, `--confirm-production` before any request, and has `--dry-run`. A version already on the target with the same options reports `unchanged`; other options are refused. New exports: `promotePlayRelease`, `PlayPromoteUncertainError`, `PlayPromoteInput`, `PlayPromoteResult`.
