export interface AitAdBridgeConfig {
  readonly adGroupIds: Readonly<Record<string, string>>;
  readonly adPlacementTypes: Readonly<Record<string, 'rewarded' | 'interstitial'>>;
}

export function extractAitAdBridgeConfig(
  input: unknown,
  sourceLabel = 'ad placements',
): AitAdBridgeConfig {
  if (!isRecord(input) || !Array.isArray(input.placements)) {
    throw new Error(`AIT ad placements are invalid: ${sourceLabel}`);
  }

  const placements: readonly unknown[] = input.placements;
  const adGroupIds: Record<string, string> = {};
  const adPlacementTypes: Record<string, 'rewarded' | 'interstitial'> = {};
  const placementIds = new Set<string>();

  for (const [placementIndex, placement] of placements.entries()) {
    if (
      !isRecord(placement)
      || typeof placement.id !== 'string'
      || (placement.type !== 'rewarded' && placement.type !== 'interstitial')
    ) {
      throw new Error(
        `AIT ad placement entry at index ${placementIndex} is invalid: ${sourceLabel}`,
      );
    }

    if (placementIds.has(placement.id)) {
      throw new Error(
        `Duplicate AIT ad placement ID "${placement.id}" at index `
        + `${placementIndex}: ${sourceLabel}`,
      );
    }
    placementIds.add(placement.id);

    const platformPlacementIds = placement.platformPlacementIds;
    const adGroupId = isRecord(platformPlacementIds) && typeof platformPlacementIds.ait === 'string'
      ? platformPlacementIds.ait.trim()
      : '';

    if (adGroupId.length > 0) {
      adGroupIds[placement.id] = adGroupId;
      adPlacementTypes[placement.id] = placement.type;
    }
  }

  return { adGroupIds, adPlacementTypes };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
