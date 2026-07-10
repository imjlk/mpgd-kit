export const defaultProductCatalogFile = 'packages/catalog/catalog.json';
export const defaultAdPlacementsFile = 'packages/catalog/placements.json';

export interface MonetizationCatalogFiles {
  readonly productCatalogFile: string;
  readonly adPlacementsFile: string;
}

export function productCatalogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return monetizationCatalogFilePaths(env).productCatalogFile;
}

export function adPlacementsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return monetizationCatalogFilePaths(env).adPlacementsFile;
}

export function monetizationCatalogFilePaths(
  env: NodeJS.ProcessEnv = process.env,
): MonetizationCatalogFiles {
  const productCatalogFile = readConfiguredPath(env.MPGD_PRODUCT_CATALOG_FILE);
  const adPlacementsFile = readConfiguredPath(env.MPGD_AD_PLACEMENTS_FILE);

  if ((productCatalogFile === undefined) !== (adPlacementsFile === undefined)) {
    throw new Error(
      'MPGD_PRODUCT_CATALOG_FILE and MPGD_AD_PLACEMENTS_FILE must be configured together.',
    );
  }

  return {
    productCatalogFile: productCatalogFile ?? defaultProductCatalogFile,
    adPlacementsFile: adPlacementsFile ?? defaultAdPlacementsFile,
  };
}

function readConfiguredPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
