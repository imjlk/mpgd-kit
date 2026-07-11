import typia from 'typia';

import type { AdPlacements } from '@mpgd/catalog';

import { adPlacementsFilePath } from './catalog-paths';
import { isCliEntrypoint, readJsonFile } from './io';

const assertAdPlacements = typia.createAssert<AdPlacements>();

export function validateAdPlacementsFile(path = adPlacementsFilePath()) {
  const adPlacements = assertAdPlacements(readJsonFile(path));
  const ids = new Set<string>();

  for (const placement of adPlacements.placements) {
    const trimmedId = placement.id.trim();

    if (trimmedId.length === 0) {
      throw new Error('Ad placement id must be non-empty.');
    }

    if (trimmedId !== placement.id) {
      throw new Error(`Ad placement id has leading or trailing whitespace: ${placement.id}`);
    }

    if (ids.has(placement.id)) {
      throw new Error(`Duplicate ad placement id: ${placement.id}`);
    }

    ids.add(placement.id);

    if (placement.type === 'rewarded' && placement.reward === undefined) {
      throw new Error(`Rewarded placement ${placement.id} must define reward.`);
    }

    for (const [target, platformPlacementId] of Object.entries(placement.platformPlacementIds)) {
      if (platformPlacementId.trim().length === 0) {
        throw new Error(`Ad placement ${placement.id} has blank platform ID for ${target}.`);
      }
    }
  }

  return adPlacements;
}

if (isCliEntrypoint(import.meta.url)) {
  const adPlacements = validateAdPlacementsFile();
  console.log(
    `Ad placements ${adPlacements.version}: ${adPlacements.placements.length} placements`,
  );
}
