import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { BrandAppIconConfig, BrandImageVariant, LoadedGameBrandConfig } from './types';

const variantNames = [
  'maskable',
  'androidForeground',
  'monochrome',
  'background',
] as const satisfies readonly BrandImageVariant[];

export function loadGameBrandConfig(gameRoot: string): LoadedGameBrandConfig {
  const configPath = resolve(gameRoot, 'mpgd.game.json');

  if (!existsSync(configPath)) {
    throw new Error(`Missing game brand config: ${configPath}`);
  }

  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  assertRecord(parsed, 'mpgd.game.json');
  assertRecord(parsed.brand, 'mpgd.game.json brand');

  const brand = parsed.brand;
  const warnings: string[] = [];
  let appIcon: BrandAppIconConfig;

  if (brand.appIcon !== undefined) {
    appIcon = readAppIconConfig(brand.appIcon, 'brand.appIcon');
  } else {
    const legacyIcon = readOptionalString(brand.icon, 'brand.icon');

    if (legacyIcon === undefined) {
      throw new Error('mpgd.game.json brand.appIcon.source is required.');
    }

    const legacyMaskable = readOptionalString(brand.maskableIcon, 'brand.maskableIcon');
    warnings.push('brand.icon and brand.maskableIcon are deprecated; migrate to brand.appIcon.');
    appIcon = {
      source: legacyIcon,
      ...(legacyMaskable === undefined ? {} : { variants: { maskable: legacyMaskable } }),
    };
  }

  return { appIcon, warnings };
}

export function applyTargetIconOverride(
  base: BrandAppIconConfig,
  override: unknown,
): BrandAppIconConfig {
  if (override === undefined) {
    return base;
  }

  assertRecord(override, 'target icon override');
  assertSupportedKeys(
    override,
    ['profile', 'source', 'backgroundColor', 'variants', 'externalUrl'],
    'target icon override',
  );
  const source = readOptionalString(override.source, 'target icon override.source') ?? base.source;
  const backgroundColor = readOptionalString(
    override.backgroundColor,
    'target icon override.backgroundColor',
  ) ?? base.backgroundColor;
  const variants = {
    ...base.variants,
    ...readVariants(override.variants, 'target icon override variants'),
  };

  return {
    source,
    ...(backgroundColor === undefined ? {} : { backgroundColor }),
    ...(Object.keys(variants).length === 0 ? {} : { variants }),
  };
}

export function resolveSecureGamePath(gameRoot: string, configuredPath: string): string {
  const root = realpathSync(gameRoot);
  const candidate = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(root, configuredPath);
  const parent = realpathSync(dirname(candidate));
  const resolved = resolve(parent, candidate.slice(dirname(candidate).length + 1));
  const relativePath = relative(root, resolved);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Brand asset path escapes the game root: ${configuredPath}`);
  }

  const real = realpathSync(resolved);
  const realRelativePath = relative(root, real);

  if (realRelativePath.startsWith('..') || isAbsolute(realRelativePath)) {
    throw new Error(`Brand asset symlink escapes the game root: ${configuredPath}`);
  }

  return real;
}

export function toGameRelativePath(gameRoot: string, path: string): string {
  return relative(realpathSync(gameRoot), realpathSync(path)).split('\\').join('/');
}

function readAppIconConfig(input: unknown, label: string): BrandAppIconConfig {
  assertRecord(input, label);
  assertSupportedKeys(input, ['source', 'backgroundColor', 'variants'], label);
  const source = readRequiredString(input.source, `${label}.source`);
  const backgroundColor = readOptionalString(input.backgroundColor, `${label}.backgroundColor`);
  const variants = readVariants(input.variants, `${label}.variants`);

  return {
    source,
    ...(backgroundColor === undefined ? {} : { backgroundColor }),
    ...(Object.keys(variants).length === 0 ? {} : { variants }),
  };
}

function readVariants(
  input: unknown,
  label: string,
): Partial<Record<BrandImageVariant, string>> {
  if (input === undefined) {
    return {};
  }

  assertRecord(input, label);
  const variants: Partial<Record<BrandImageVariant, string>> = {};

  for (const name of variantNames) {
    const path = readOptionalString(input[name], `${label}.${name}`);

    if (path !== undefined) {
      variants[name] = path;
    }
  }

  for (const key of Object.keys(input)) {
    if (!variantNames.includes(key as BrandImageVariant)) {
      throw new Error(`${label}.${key} is not a supported app icon variant.`);
    }
  }

  return variants;
}

function assertSupportedKeys(
  input: Record<string, unknown>,
  supportedKeys: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(input)) {
    if (!supportedKeys.includes(key)) {
      throw new Error(`${label}.${key} is not supported.`);
    }
  }
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}

function readRequiredString(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return input.trim();
}

function readOptionalString(input: unknown, label: string): string | undefined {
  if (input === undefined) {
    return undefined;
  }

  return readRequiredString(input, label);
}
