import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export function normalizeMonetizationCatalogEnv(
  baseEnv: NodeJS.ProcessEnv,
  fallbackBaseDir = process.cwd(),
): NodeJS.ProcessEnv {
  const productCatalogFile = readConfiguredEnvPath(baseEnv.MPGD_PRODUCT_CATALOG_FILE);
  const adPlacementsFile = readConfiguredEnvPath(baseEnv.MPGD_AD_PLACEMENTS_FILE);

  if ((productCatalogFile === undefined) !== (adPlacementsFile === undefined)) {
    throw new Error(
      'MPGD_PRODUCT_CATALOG_FILE and MPGD_AD_PLACEMENTS_FILE must be configured together.',
    );
  }

  if (productCatalogFile === undefined || adPlacementsFile === undefined) {
    return {};
  }

  const callerCwd = resolveConfiguredBaseDir(
    baseEnv,
    fallbackBaseDir,
    productCatalogFile,
    adPlacementsFile,
  );

  return {
    MPGD_PRODUCT_CATALOG_FILE: resolve(callerCwd, productCatalogFile),
    MPGD_AD_PLACEMENTS_FILE: resolve(callerCwd, adPlacementsFile),
  };
}

function readConfiguredEnvPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function resolveConfiguredBaseDir(
  baseEnv: NodeJS.ProcessEnv,
  fallbackBaseDir: string,
  productCatalogFile: string,
  adPlacementsFile: string,
): string {
  const candidates = [
    fallbackBaseDir,
    readConfiguredEnvPath(baseEnv.INIT_CWD),
    readConfiguredEnvPath(baseEnv.PWD),
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (
      candidate !== undefined
      && configuredFileExists(candidate, productCatalogFile)
      && configuredFileExists(candidate, adPlacementsFile)
    ) {
      return candidate;
    }
  }

  return fallbackBaseDir;
}

function configuredFileExists(baseDir: string, file: string): boolean {
  return existsSync(isAbsolute(file) ? file : resolve(baseDir, file));
}
