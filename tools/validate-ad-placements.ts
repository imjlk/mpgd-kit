import typia from 'typia';

import { resolveCatalogCurrencies, type AdPlacements, type ProductCatalog } from '@mpgd/catalog';

import { adPlacementsFilePath, productCatalogFilePath } from './catalog-paths';
import { isCliEntrypoint, readJsonFile } from './io';

const assertAdPlacements = typia.createAssert<AdPlacements>();
const assertProductCatalogCurrencies = typia.createAssert<Pick<ProductCatalog, 'currencies'>>();

export function validateAdPlacementsFile(
  path = adPlacementsFilePath(),
  catalogPath = productCatalogFilePath(),
) {
  const adPlacements = assertAdPlacements(readJsonFile(path));
  // Reward currencies must be declared by the product catalog the game ships.
  const currencies = resolveCatalogCurrencies(
    assertProductCatalogCurrencies(readJsonFile(catalogPath)),
  );
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

    if (placement.reward?.type === 'currency' && !currencies.has(placement.reward.currency)) {
      throw new Error(
        `Ad placement ${placement.id} rewards undeclared currency ${placement.reward.currency}; `
          + `declared currencies: ${[...currencies].join(', ')}.`,
      );
    }

    for (const [target, platformPlacementId] of Object.entries(placement.platformPlacementIds)) {
      if (typeof platformPlacementId !== 'string' || platformPlacementId.trim().length === 0) {
        throw new Error(`Ad placement ${placement.id} has blank platform ID for ${target}.`);
      }
    }
  }

  return adPlacements;
}

if (isCliEntrypoint(import.meta.url)) {
  const adPlacements = validateAdPlacementsFile();
  console.info(
    `Ad placements ${adPlacements.version}: ${adPlacements.placements.length} placements`,
  );
}
