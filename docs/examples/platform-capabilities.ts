import type { CommerceCapabilities, PlatformGateway } from '@mpgd/platform';
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
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #12e3a3a Checked the fresh boolean read and separate unknown state after a rejection; this example does not infer readiness details.
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

export type StoreAvailability =
  | { readonly status: 'sellable'; readonly subscriptions: boolean }
  | { readonly status: 'unavailable'; readonly availability: CommerceCapabilities['availability'] }
  | { readonly status: 'unknown'; readonly error: unknown };

/**
 * Decide at the decision point whether to show a store, from the required `commerce` block alone.
 * @evidence docs/specs/platform-capability-snapshots.md#snapshot-shape Reads the required commerce block, the only commerce source of a snapshot.
 * @evidenceReview docs/specs/platform-capability-snapshots.md#snapshot-shape #12e3a3a Checked the example reads `commerce.availability` and `commerce.purchase` and never a removed boolean flag, and keeps a rejected read distinct from an unsupported store.
 */
export async function readStoreAvailability(
  gateway: Pick<PlatformGateway, 'getCapabilities'>,
): Promise<StoreAvailability> {
  try {
    const { commerce } = await gateway.getCapabilities();
    if (commerce.availability !== 'available') {
      return { status: 'unavailable', availability: commerce.availability };
    }
    const sellsOneTime = commerce.purchase.consumable || commerce.purchase.durable;
    if (!sellsOneTime && !commerce.purchase.subscription) {
      return { status: 'unavailable', availability: 'unsupported' };
    }
    return { status: 'sellable', subscriptions: commerce.purchase.subscription };
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
