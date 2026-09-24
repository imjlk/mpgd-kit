import type { PlatformGateway } from '@mpgd/platform';
import {
  runPlatformGatewayCapabilityConformance,
  type PlatformGatewayCapabilityConformanceFixture,
  type PlatformGatewayCapabilityConformanceReport,
} from '@mpgd/platform/capability-conformance';

export type RewardedAdAvailability =
  | { readonly status: 'available' | 'unavailable' }
  | { readonly status: 'unknown'; readonly error: unknown };

/**
 * Read at the decision point and keep a failed read distinct from a false flag.
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Gets the current snapshot for this decision, if the read succeeds.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #a1834db Checked the fresh boolean read and separate unknown state after a rejection; this example does not infer readiness details.
 */
export async function readRewardedAdAvailability(
  gateway: Pick<PlatformGateway, 'getCapabilities'>,
): Promise<RewardedAdAvailability> {
  try {
    const capabilities = await gateway.getCapabilities();
    return { status: capabilities.rewardedAds ? 'available' : 'unavailable' };
  } catch (error) {
    return { status: 'unknown', error };
  }
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
