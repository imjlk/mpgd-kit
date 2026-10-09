# Asset-pack playable consumer measurements

Run the private Phaser explorer with `pnpm --dir examples/asset-packs test:measure`
after `pnpm build:packages` and installing its Chromium browser. The measurement
script is [test/measure.mjs](../examples/asset-packs/test/measure.mjs).
It builds and inventories actual bundled/hybrid outputs, independently verifies
payload exclusion, enters Grove → Dunes → Grove, verifies arrow-key movement and
checks that shutdown returns all asset ownership.

The checked-in [raw report](../examples/asset-packs/evidence/measurements-2026-10-09.json)
records three fresh contexts per scenario, Node/Chromium/CPU versions, source
revision, complete artifact inventory/digests and individual observations.
All scenarios use Canvas and the same optional audio closure. The separate
loopback origin adds a modeled 40 ms delay to each response; this is a controlled
comparison, not a production network/device benchmark. Prefetch waits for both
packs to warm, recording its observed idle lead time separately from entry.
This lead starts when the driver observes idle, including its post-boot GC
checkpoint; some warming can already have started before that observation.

## Metrics and limits

- App artifact bytes are the complete build directory, including Phaser/app JS,
  CSS, worker, reports and packaged media. They are uncompressed file bytes.
- Entry time starts at the consumer's selection handler and ends after queued
  preparation, download/decode and display-object handover. It excludes later
  first-frame/GPU work. It does not include the prefetch idle lead time.
- HTTP byte counts are completed static-server response bodies. They exclude
  headers, request bytes and physical wire overhead. Every fresh context has a
  cold HTTP cache; the explicit IndexedDB case alone tests persistent reuse.
- `Runtime.getHeapUsage` samples the main renderer V8 isolate during entries,
  with explicit post-GC checkpoints. The sampled maximum is an observation,
  not an exact instantaneous peak or total process/native/GPU memory. Worker
  isolates are outside this measurement. Timing runs also include sampler
  overhead; post-entry GC checkpoints are outside the recorded entry interval.
- Known RGBA is width × height × 4, PCM is accepted AudioBuffer sample bytes,
  HTML5 Blob and persistent artifact bytes have their own scopes. None is a
  proxy for total memory. Prefetch retains both themes until handed over/evicted,
  so its known resident payload can exceed an individual active scene's payload.

For `delivery=mixed`, this example routes shared files and theme/audio archives
through the separate delivery origin. The hybrid build still contains the shared
488-byte PNG used by the ordinary files scenario; the inventory reports those
bytes even though the mixed scenario reads its shared file from the delivery
origin. Production target policy resolves packaged and remote artifacts through
`@mpgd/target-config/asset-packs`; installed-consumer acceptance tests that route.

## Native and target-build evidence

PR [#306](https://github.com/imjlk/mpgd-kit/pull/306) built actual staging web,
Apps in Toss wrapper and Android debug APK artifacts from the same offline Grove
policy. Verified packaged assets plus namespace metadata totaled **62,328 bytes**;
remote-only objects totaled **43,301 bytes**. The actual APK was **7,272,966 bytes**,
and its expanded packaged namespace also totaled **62,328 bytes**. All packaged
object digests matched; remote-only payload digests were absent across the APK.
This run used source revision `4b967ea01a1be6891eec2e448770daa7555713ac` before the
subsequent final native-audit review fixes. The final sequential audit was also
run against that APK; full CI passed on the final PR head. No physical-device or
signed store-release performance measurement is claimed.

The native auditor additionally has APK/AAB/IPA/expanded-iOS fixtures for wrong
namespaces, missing or corrupt packaged resources and remote-payload inclusion.
Its limits and target-policy behavior are described in
[the delivery contract](ASSET_PACK_DELIVERY.md).
