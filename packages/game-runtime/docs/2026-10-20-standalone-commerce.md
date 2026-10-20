# Standalone commerce presentation — 2026-10-20

## Scope

Extract the existing native purchase UI coordinator from the ad-dependent gateway into `@mpgd/game-runtime/commerce`. A checkout-only host supplies its CommerceProvider and an app-owned presentation scope. The full gateway reuses this implementation; its legacy no-facts pass-through remains unchanged.

Standalone checkout without native presentation facts rejects before calling the provider. Available-purchase recovery, finalization, catalog and transaction subscriptions retain original method receivers. Duplicate invocations coalesce; changed arguments, concurrent native surfaces and bounded-history exhaustion reject. SDK business results, failures, timeout and generic app resume are not close evidence. Late matching native closure releases the lease even after wrapper disposal.

This is UI coordination, not financial authority. Receipt verification and durable fulfillment remain in game-services. No Billing/StoreKit native UI-close instrumentation, device acceptance, platform purchase activation, SDK version change, deployment or npm publish is included. The native host still needs to supply and verify that protocol before enabling new checkout.

## Verification

- Full game-runtime suite:200 tests across13 files pass (8 new standalone tests plus existing gateway/ad behavior).
- New fixture formatting cleanup rerun:8/8 pass. Standard/headless strict projects and strict no-DOM consumer declaration check pass.
- Package build and real tarball consumer pass with and without optional Phaser, including the new export. Existing JavaScript consumer fixtures remain their documented no-loader exception; no authored JavaScript tool was added.
- Mandatory graph preset `commerce-presentation`:4 exact anchors pass, automatically included by CI graph:preflight. Existing game-services authority contracts were not weakened or retargeted.
- JavaScript policy and diff whitespace checks pass. Sampo minor changeset added to the existing independent game-runtime package. `sampo release --dry-run` was refused on this non-release branch; no release configuration was changed to bypass it.
- Initial compile found an invalid test fixture shape and root formatting diagnostics; corrected them before the passing runs. mise's child PATH initially chose system Node23; final package/build/consumer checks explicitly use the configured Node24.11.0 path. Pre-existing unrelated formatter output was restored.

## OCR delegate review

Host review, not an independent external reviewer.12 initial files reviewed including the3 OCR-default exclusions (README, changeset, new tests); this record reviewed additionally,13/13 total,0 skipped, no remaining findings. Covered package export and changeset; source extraction and unchanged gateway compatibility; strict missing-facts gate; lifecycle/disposal/replay/observer ownership; recovery forwarding; packed and type consumers; graph anchors and documentation.

Companion Foundation change: https://github.com/imjlk/mpgd-games/pull/163.
Game integration and target-specific follow-up: https://github.com/imjlk/mpgd-games/pull/172.
