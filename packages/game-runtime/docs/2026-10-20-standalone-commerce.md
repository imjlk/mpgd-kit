# Standalone commerce presentation — 2026-10-20

## Scope

Extract the existing native purchase UI coordinator from the ad-dependent gateway into `@mpgd/game-runtime/commerce`. A checkout-only host supplies its CommerceProvider and an app-owned presentation scope. The full gateway reuses this implementation; its legacy no-facts pass-through remains unchanged.

Standalone checkout without native presentation facts rejects before calling the provider. Available-purchase recovery, finalization, catalog and transaction subscriptions retain original method receivers. Duplicate invocations coalesce; changed arguments, concurrent native surfaces and bounded-history exhaustion reject. SDK business results, failures, timeout and generic app resume are not close evidence. Late matching native closure releases the lease even after wrapper disposal.

This is UI coordination, not financial authority. Receipt verification and durable fulfillment remain in game-services. No Billing/StoreKit native UI-close instrumentation, device acceptance, platform purchase activation, SDK version change, deployment or npm publish is included. The native host still needs to supply and verify that protocol before enabling new checkout.

## Verification

- Full game-runtime suite: 200 tests across 13 files pass (8 new standalone tests plus existing gateway/ad behavior).
- New fixture formatting cleanup rerun: 8/8 pass. Standard/headless strict projects and strict no-DOM consumer declaration check pass.
- Package build and real tarball consumer pass with and without optional Phaser, including the new export. Existing JavaScript consumer fixtures remain their documented no-loader exception; no authored JavaScript tool was added.
- Mandatory graph preset `commerce-presentation`: 4 exact anchors pass, automatically included by CI graph:preflight. Existing game-services authority contracts were not weakened or retargeted.
- JavaScript policy and diff whitespace checks pass. Sampo minor changeset added to the existing independent game-runtime package. `sampo release --dry-run` was refused on this non-release branch; no release configuration was changed to bypass it.
- Initial compile found an invalid test fixture shape and root formatting diagnostics; corrected them before the passing runs. mise's child PATH initially chose system Node 23; final package/build/consumer checks explicitly use the configured Node 24.11.0 path. Pre-existing unrelated formatter output was restored.

## OCR delegate review

Host review, not an independent external reviewer. 12 initial files reviewed including the 3 OCR-default exclusions (README, changeset, new tests); this record reviewed additionally, 13/13 total, 0 skipped, no remaining findings. Covered package export and changeset; source extraction and unchanged gateway compatibility; strict missing-facts gate; lifecycle/disposal/replay/observer ownership; recovery forwarding; packed and type consumers; graph anchors and documentation.

Companion Foundation change: https://github.com/imjlk/mpgd-games/pull/163.
Game integration and target-specific follow-up: https://github.com/imjlk/mpgd-games/pull/172.


## PR400 review follow-up

Codex review 4322985258 and 4322985267 exposed a missing reconciler boundary: injected/classified non-launch facts were consumed locally, and the failed promise prevented a same-key retry. The new integration cases fail on the original commit in all 3 configurations: native facts cannot retry; injected/classified facts terminalize the durable intent. The patched coordinator publishes validated/normalized observations, including classifiers, and permits only proven unopened retryable failures to retry the same fingerprint. A later trusted not-started fact releases that key only after a retryable failure that never opened; it does not reopen a purchased, launched, opened, or non-retryable attempt, and it does not grant. The history entry and capacity remain bound to that identity, and concurrent/uncertain calls still coalesce.

Actual game-services reconciler integration now verifies native, external and classifier sources, durable requested→cancelled state, same-key retry at capacity 1, changed-product rejection, increasing downstream sequences and 0 backend grants. A fourth regression prevents reopened checkout after open/unknown failures. Full runtime suite 204 tests, built/packed ESM consumers and headless declarations pass. The minor documentation spacing comment 4323003332 is fixed.

CI prepare originally failed on the missing source alias for the new export and 2 root formatting diagnostics. Added the alias to tsconfig.base.json (the clean CI tree cannot rely on locally built dist) and formatted the affected tests. Local root check and new CI run are recorded separately; do not treat the original CI run as passing.

Fresh follow-up validation: root `pnpm check` passes, including the CI prepare checks and recursive package checks. Mandatory commerce graph remains 4 anchors. OCR delegate host review of all 5 changed files (including default-excluded tests/docs) found no remaining issue in this patch; no files skipped. New remote CI is still a separate result.
