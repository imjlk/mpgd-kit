export const defaultProductCatalogFile = 'packages/catalog/catalog.json';
export const defaultAdPlacementsFile = 'packages/catalog/placements.json';

export function productCatalogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return readConfiguredPath(env.MPGD_PRODUCT_CATALOG_FILE) ?? defaultProductCatalogFile;
}

export function adPlacementsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return readConfiguredPath(env.MPGD_AD_PLACEMENTS_FILE) ?? defaultAdPlacementsFile;
}

function readConfiguredPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
