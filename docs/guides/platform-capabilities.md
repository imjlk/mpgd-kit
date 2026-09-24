<!--
@evidence docs/standards/documentation-principles.md#readiness-levels Separates the shared contract, fixture checks, device validation, and release readiness below.
@evidenceReview docs/standards/documentation-principles.md#readiness-levels #69ee134 Reviewed the stated scope of each validation level against this guide.
@evidence docs/standards/documentation-principles.md#failure-paths Explains absent capabilities and operations that fail after a positive read.
@evidenceReview docs/standards/documentation-principles.md#failure-paths #2ed77d9 Checked rejected reads, unsupported capabilities, and post-check operation failures.
@evidence docs/standards/documentation-principles.md#execution-context Names the workspace command and its local, non-device validation scope.
@evidenceReview docs/standards/documentation-principles.md#execution-context #066647a Checked the command's package script and its validation boundary.
-->
# Read platform capabilities

Use `PlatformGateway.getCapabilities()` at the point where a game needs a
capability. The returned booleans describe the provider's current exposed
state; they do not grant a purchase or reward, and they do not prove that an
operation will complete.

## Read a fresh snapshot

<!--
@evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Explains the required boolean fields, optional banner field, and fresh-read guarantee.
@evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f83948b Compared the snapshot description with the runner and gateway type.
-->
Each read returns a separate object. Required fields are booleans; the
optional `bannerAds` field behaves as `false` when absent. Re-read before a
feature is shown or used. If a capability is `false`, hide or disable that
path. Even after a `true` snapshot, handle an operation that fails or becomes
unavailable; the snapshot is not a promise that the operation succeeds.
On bridged targets, `getCapabilities()` itself may reject when the bridge is
missing or the method is unsupported. Catch that rejection, treat availability
as unknown, and keep the gated action disabled while showing a retry or setup
path appropriate to the target. Do not present a rejected read as an all-`false`
snapshot. Where an error exposes a platform code or `retryable` flag, use it
to distinguish temporary bridge trouble from missing setup; otherwise fail
closed. Keep handling operation failure even after a successful `true` read.

See the type-checked
[`readRewardedAdAvailability` example](https://github.com/imjlk/mpgd-kit/blob/main/docs/examples/platform-capabilities.ts)
for a decision-point read that keeps a rejected bridge call distinct from a
resolved `false` flag. Handle an actual ad operation result separately.

## Verify a gateway fixture

<!--
@link ../../packages/platform/src/capability-conformance.ts#runPlatformGatewayCapabilityConformance Uses the published subpath runner that checks gateway fixtures.
@evidenceReview ../../packages/platform/src/capability-conformance.ts#runPlatformGatewayCapabilityConformance #97ca29b Reviewed the exported runner signature and fixture validation behavior.
@evidence docs/specs/platform-capability-snapshots.md#fixture-validation Describes the fixture input and result contract enforced by this runner.
@evidenceReview docs/specs/platform-capability-snapshots.md#fixture-validation #d566052 Checked the input guards and passed-fixture report.
-->
Import `runPlatformGatewayCapabilityConformance` from
`@mpgd/platform/capability-conformance`. Supply named fixtures with a gateway,
its expected target, and its expected capability state. The runner rejects an
empty fixture set, blank or duplicate names, and mismatched gateways; on
success it returns the names that passed.

From the repository root,
`pnpm --dir packages/platform exec vitest run src/capability-conformance.test.ts`
runs the source tests without a package build. For the package's full test
script and dist-import checks, first run `pnpm build:packages @mpgd/platform`,
then `pnpm --dir packages/platform test`. For the cross-adapter smoke, first
run `pnpm build:packages`, then
`pnpm smoke:platform-capability-conformance`; it checks configured adapter
and target-wrapper fixtures. None of these commands is a physical-device or
release-readiness certification.

The type-checked
[`verifyCapabilityFixture` example](https://github.com/imjlk/mpgd-kit/blob/main/docs/examples/platform-capabilities.ts)
shows the runner input and report shape.

## Recheck after a provider change

<!--
@link ../../packages/platform/src/capability-conformance.ts#PlatformGatewayCapabilityConformanceTransition.update Identifies the public transition hook that changes the fixture provider before a reread.
@evidenceReview ../../packages/platform/src/capability-conformance.ts#PlatformGatewayCapabilityConformanceTransition.update #0b0f9f6 Reviewed the published transition hook signature and its call site in the runner.
@evidence docs/specs/platform-capability-snapshots.md#provider-transitions Explains how a transition fixture proves fresh provider reads.
@evidenceReview docs/specs/platform-capability-snapshots.md#provider-transitions #839c0c8 Compared transition behavior with the runner's update and reread sequence.
-->
If a provider becomes ready or unavailable after startup, call
`getCapabilities()` again. A transition fixture can change the provider's
state and require the next snapshot to match it. This checks that the adapter
or target wrapper does not keep returning its initial state; it still does
not prove that the corresponding platform SDK works on a real device.
The type-checked
[`readCloudSaveTransition` example](https://github.com/imjlk/mpgd-kit/blob/main/docs/examples/platform-capabilities.ts)
shows why the second read must happen after the provider update.

From the repository root, `pnpm docs:examples:check` checks these example
types, and `pnpm docs:examples:test` runs their source-backed Vitest fixtures
without a package build. The tests use a fake gateway; they do not validate a
published tarball, call a platform SDK, or certify a device.
