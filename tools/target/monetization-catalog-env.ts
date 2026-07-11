import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { configuredMonetizationCatalogFilePaths, readConfiguredPath } from '../catalog-paths';

export function normalizeMonetizationCatalogEnv(
  baseEnv: NodeJS.ProcessEnv,
  fallbackBaseDir = process.cwd(),
): NodeJS.ProcessEnv {
  const configuredFiles = configuredMonetizationCatalogFilePaths(baseEnv);

  if (configuredFiles === undefined) {
    return {};
  }

  const { productCatalogFile, adPlacementsFile } = configuredFiles;
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

function resolveConfiguredBaseDir(
  baseEnv: NodeJS.ProcessEnv,
  fallbackBaseDir: string,
  productCatalogFile: string,
  adPlacementsFile: string,
): string {
  const candidates = [
    fallbackBaseDir,
    readConfiguredPath(baseEnv.INIT_CWD),
    readConfiguredPath(baseEnv.PWD),
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
