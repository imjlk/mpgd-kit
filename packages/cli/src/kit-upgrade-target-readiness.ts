import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { assertAdPlacements, assertProductCatalog } from '@mpgd/catalog';
import { assertTargetConfigMatrix, createEffectiveTargetConfig } from '@mpgd/target-config';

const require = createRequire(import.meta.url);

export interface KitUpgradeTargetAdvisory {
  readonly target: string;
  readonly kind: 'missing-product-id' | 'missing-placement-id' | 'not-assessed';
  readonly logicalId?: string;
  readonly message: string;
}

/** Read-only hints, not a substitute for target validation after an upgrade. */
export function inspectKitUpgradeTargetReadiness(
  gameRoot: string,
  targetsFile: string,
): readonly KitUpgradeTargetAdvisory[] {
  if (!existsSync(targetsFile)) {
    return [notAssessed('*', 'No game-owned targets file is available.')];
  }
  if (
    process.env.MPGD_PRODUCT_CATALOG_FILE?.trim()
    || process.env.MPGD_AD_PLACEMENTS_FILE?.trim()
  ) {
    const message = 'Custom catalog or placement paths are not inspected; '
      + 'validate targets after upgrading.';
    return [notAssessed('*', message)];
  }

  try {
    const configured = asRecord(readGameOwnedJsonFile(gameRoot, targetsFile), 'targets file');
    const targets = asRecord(configured.targets, 'targets');
    const baseFile = require.resolve('@mpgd/target-config/targets.json');
    const base = assertTargetConfigMatrix(JSON.parse(readFileSync(baseFile, 'utf8')) as unknown);
    const catalogFile = path.join(gameRoot, 'mpgd.catalog.json');
    const placementsFile = path.join(gameRoot, 'mpgd.ad-placements.json');
    if (existsSync(catalogFile) !== existsSync(placementsFile)) {
      return [notAssessed(
        '*',
        'Default mpgd.catalog.json and mpgd.ad-placements.json must be present together; '
          + 'custom paths are not assessed.',
      )];
    }
    const catalog = existsSync(catalogFile)
      ? assertProductCatalog(readGameOwnedJsonFile(gameRoot, catalogFile))
      : assertProductCatalog({ version: 'none', products: [] });
    const placements = existsSync(placementsFile)
      ? assertAdPlacements(readGameOwnedJsonFile(gameRoot, placementsFile))
      : assertAdPlacements({ version: 'none', placements: [] });
    const advisories: KitUpgradeTargetAdvisory[] = [];

    for (const target of Object.keys(targets).sort()) {
      const policy = base.targets[target];
      if (policy === undefined) {
        const message = 'No built-in runtime policy is available; '
          + 'validate this custom target after upgrading.';
        advisories.push(notAssessed(target, message));
        continue;
      }
      try {
        const platform = asRecord(targets[target], `target ${target}`);
        const effective = createEffectiveTargetConfig({
          target,
          targetConfigVersion: base.version,
          config: policy,
          catalog,
          adPlacements: placements,
          platformTarget: {
            kind: String(platform.kind ?? ''),
            adapter: String(platform.adapter ?? ''),
            ...(platform.authoritativeGameServices === false
              ? { authoritativeGameServices: false }
              : {}),
          },
        });

        // Devvit validates product SKUs against its wrapper contract, not catalog platform IDs.
        if (effective.runtime !== 'devvit-web') {
          for (const product of effective.monetization.products) {
            if (product.reason === 'missing-platform-id') {
              advisories.push({
                target,
                kind: 'missing-product-id',
                logicalId: product.id,
                message: `Product ${product.id} needs platformProductIds.${target}.`,
              });
            }
          }
        }
        for (const placement of effective.ads.placements) {
          if (placement.reason === 'missing-platform-id') {
            advisories.push({
              target,
              kind: 'missing-placement-id',
              logicalId: placement.id,
              message: `Ad placement ${placement.id} needs platformPlacementIds.${target}.`,
            });
          }
        }
      } catch (error) {
        advisories.push(notAssessed(target, `Could not inspect target: ${formatError(error)}`));
      }
    }

    return advisories;
  } catch (error) {
    return [notAssessed('*', `Target readiness could not be assessed: ${formatError(error)}`)];
  }
}

function readGameOwnedJsonFile(gameRoot: string, file: string): unknown {
  if (!existsSync(file)) {
    throw new Error(`Missing game-owned ${path.basename(file)}.`);
  }
  if (lstatSync(file).isSymbolicLink() || !inside(gameRoot, realpathSync(file))) {
    throw new Error(`Refusing to inspect a linked or external ${path.basename(file)}.`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function notAssessed(target: string, message: string): KitUpgradeTargetAdvisory {
  return { target, kind: 'not-assessed', message };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
