---
npm/@mpgd/cli: minor (Added)
---

`mpgd store release plan|apply|status|publish|phased` automates the App Store Connect steps between a build in TestFlight and a version submitted for review, in the reviewed plan / apply style of `store presence` and `store products`, through the pinned `asc` 5.5.0.

- `plan` creates the iOS version (alone, so its store page can follow) or reuses the one in preparation (renaming another editable version string), selects the build (`--build-number`, the newest of the version, or the build `deploy run` recorded with `--game-id`/`--release`), and plans What's New from the store presence file, the copyright line, App Review information, the release type (`manual` by default, `after-approval`, or `scheduled` with `--release-date`), phased release, the in-app purchases that are `READY_TO_SUBMIT`, and the review submission. It never writes.
- The plan fails closed with what to do when the build is missing, processing, invalid, expired or lacks export compliance; a store presence locale is not on the version or an update lacks What's New; the iPhone or (universal app, from `mpgd.targets.json` `iosDeviceFamily`) 13-inch iPad screenshots are missing; the age rating was never answered; the copyright line or App Review contact is missing; an in-app purchase is unfinished (or skip it with `--skip-iap`); or another submission blocks this one.
- `apply --plan <file> --approve` re-plans, refuses a moved App Store Connect or a plan with blockers, and performs exactly that plan; `--dry-run` prints the writes. A re-run is a no-op, and after a partial failure a new plan picks up the created version, attached build and open submission.
- The demo account comes from the environment variables `appStore.review.demoAccount` names; no secret is written to the plan file. asc takes the password only as a command-line flag, so it is visible in the local process list while that call runs.
- `status` reports where the version and its review submission stand, `publish` releases an approved version waiting for a manual release, and `phased --action pause|resume|complete` changes a phased release.
- App Privacy answers stay manual: the public App Store Connect API has no resource for them.
