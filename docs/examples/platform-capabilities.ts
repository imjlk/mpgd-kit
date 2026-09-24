import type { PlatformGateway } from '@mpgd/platform';
import {
  runPlatformGatewayCapabilityConformance,
  type PlatformGatewayCapabilityConformanceFixture,
  type PlatformGatewayCapabilityConformanceReport,
} from '@mpgd/platform/capability-conformance';

/**
 * Read at the decision point, rather than caching the provider state at startup.
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Gets the current snapshot for this decision.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #f83948b Checked that a fresh getCapabilities call supplies the current rewarded-ad flag.
 */
export async function canOfferRewardedAd(
  gateway: Pick<PlatformGateway, 'getCapabilities'>,
): Promise<boolean> {
  const capabilities = await gateway.getCapabilities();
  return capabilities.rewardedAds;
}

/**
 * A provider update requires another read; a previous snapshot is not live.
 * @evidence docs/specs/platform-capability-snapshots.md#provider-transitions Reads before and after a provider transition.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#provider-transitions #839c0c8 Checked the update call sits between two independent gateway reads.
 */
export async function readCloudSaveTransition(
  gateway: Pick<PlatformGateway, 'getCapabilities'>,
  updateProvider: () => Promise<void> | void,
): Promise<readonly [before: boolean, after: boolean]> {
  const before = (await gateway.getCapabilities()).cloudSave;
  await updateProvider();
  const after = (await gateway.getCapabilities()).cloudSave;
  return [before, after];
}

/**
 * Run a named adapter fixture against its declared target and expected state.
 * @evidence docs/specs/platform-capability-snapshots.md#fixture-validation Passes a named fixture to the published runner and returns its report.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#fixture-validation #d566052 Checked the runner input and passed-fixture report contract.
 */
export async function verifyCapabilityFixture(
  fixture: PlatformGatewayCapabilityConformanceFixture,
): Promise<PlatformGatewayCapabilityConformanceReport> {
  return runPlatformGatewayCapabilityConformance({ fixtures: [fixture] });
}
