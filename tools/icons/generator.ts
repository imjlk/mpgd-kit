import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

import sharp, { type Metadata } from 'sharp';

import type { PlatformTargetConfig } from '../target/schemas';
import {
  applyTargetIconOverride,
  loadGameBrandConfig,
  resolveSecureGamePath,
  toGameRelativePath,
} from './config';
import {
  isPngOpaque,
  pixelSha256,
  renderProfileOutput,
  sha256,
  validateBrandImage,
  type ValidatedBrandImage,
} from './image';
import { resolveTargetIconProfile } from './profiles';
import {
  iconGeneratorVersion,
  iconManifestSchemaVersion,
  type BrandAppIconConfig,
  type BrandImageVariant,
  type GeneratedTargetIcons,
  type IconManifest,
  type IconManifestOutput,
  type IconOutputProfile,
} from './types';

const defaultBackgroundColor = '#ffffff';
const devvitIconMaximumBytes = 500 * 1024;
const brandImageVariants = [
  'maskable',
  'androidForeground',
  'monochrome',
  'background',
] as const satisfies readonly BrandImageVariant[];

export async function generateTargetIcons(input: {
  readonly gameRoot: string;
  readonly targetName: string;
  readonly target: PlatformTargetConfig;
  readonly profile: string;
  readonly enforceExternalReadiness?: boolean;
}): Promise<GeneratedTargetIcons> {
  const strict = input.profile === 'production';
  const loaded = loadGameBrandConfig(input.gameRoot);
  const appIcon = applyTargetIconOverride(loaded.appIcon, input.target.icon);
  const canonicalPath = resolveSecureGamePath(input.gameRoot, loaded.appIcon.source);
  const renderPath = resolveSecureGamePath(input.gameRoot, appIcon.source);
  const canonical = await validateBrandImage(canonicalPath, { strict, minimumSize: 1024 });
  const renderSource = canonicalPath === renderPath
    ? canonical
    : await validateBrandImage(renderPath, { strict, minimumSize: 1024 });
  const profile = resolveTargetIconProfile(input.targetName, input.target);
  const outputDir = resolveTargetOutputDir(
    input.gameRoot,
    canonical.sha256,
    profile.id,
    input.targetName,
  );
  const backgroundColor = appIcon.backgroundColor ?? defaultBackgroundColor;
  const variantSources = await loadVariantSources(input.gameRoot, appIcon, strict);
  const sharedVariantSources = await loadVariantSources(input.gameRoot, loaded.appIcon, strict);
  const sharedConfigSha256 = createRenderConfigSha256({
    canonicalSourcePath: loaded.appIcon.source,
    appIcon: loaded.appIcon,
    backgroundColor: loaded.appIcon.backgroundColor ?? defaultBackgroundColor,
    canonical,
    renderSource: canonical,
    variantSources: sharedVariantSources,
    externalUrl: undefined,
  });
  const renderConfigSha256 = createRenderConfigSha256({
    canonicalSourcePath: loaded.appIcon.source,
    appIcon,
    backgroundColor,
    canonical,
    renderSource,
    variantSources,
    externalUrl: input.target.icon?.externalUrl,
  });
  const warnings = [...loaded.warnings, ...canonical.warnings, ...renderSource.warnings];

  if (profile.outputs.some((output) => output.opaque)) {
    await assertOpaqueBackgroundColor(backgroundColor);
  }

  assertSafeGeneratedPath(input.gameRoot, outputDir);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const outputs: IconManifestOutput[] = [];

  for (const output of profile.outputs) {
    const variantPath = output.sourceVariant === undefined
      ? undefined
      : appIcon.variants?.[output.sourceVariant];

    if (output.requiredVariant === true && variantPath === undefined) {
      warnings.push(
        `${input.targetName} omitted optional ${output.sourceVariant ?? output.purpose} output.`,
      );
      continue;
    }

    const image = await resolveOutputImage({
      appIcon,
      output,
      renderSource,
      variantSources,
    });
    const bytes = image === undefined
      ? await renderSolidBackground(output, backgroundColor)
      : await renderProfileOutput({
          image,
          width: output.width,
          height: output.height,
          safeZone: output.safeZone,
          opaque: output.opaque,
          backgroundColor,
          monochrome: output.sourceVariant === 'monochrome',
        });
    const outputPath = resolve(outputDir, output.file);

    if (output.opaque && !(await isPngOpaque(bytes))) {
      throw new Error(`${input.targetName} ${output.purpose} output must be fully opaque.`);
    }

    writeFileSync(outputPath, bytes);
    outputs.push({
      target: input.targetName,
      purpose: output.purpose,
      path: `icons/${output.file}`,
      width: output.width,
      height: output.height,
      format: 'png',
      opaque: output.opaque,
      sha256: sha256(bytes),
      pixelSha256: await pixelSha256(bytes),
    });
  }

  const readiness = createReadiness(input, outputs, input.target.icon?.externalUrl);
  const manifest: IconManifest = {
    schemaVersion: iconManifestSchemaVersion,
    canonicalSource: toManifestSource(input.gameRoot, canonical),
    renderSource: toManifestSource(input.gameRoot, renderSource),
    variantSources: Object.fromEntries(
      Object.entries(variantSources).map(([variant, image]) => [
        variant,
        toManifestSource(input.gameRoot, image),
      ]),
    ),
    sharedConfigSha256,
    renderConfigSha256,
    generatorVersion: iconGeneratorVersion,
    targetProfile: profile.id,
    targetProfileVersion: profile.version,
    outputs,
    warnings,
    ...(readiness === undefined ? {} : { readiness }),
  };
  if (profile.id === 'devvit') {
    const output = requireOutput(outputs, 'app-icon');
    const size = readFileSync(resolve(outputDir, output.path.slice('icons/'.length))).byteLength;

    if (size > devvitIconMaximumBytes) {
      throw new Error(
        `Devvit marketing icon is ${size} bytes; the generated 1024x1024 PNG must be at most ${devvitIconMaximumBytes} bytes.`,
      );
    }
  }

  const manifestPath = join(outputDir, 'icon-manifest.json');
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;

  writeFileSync(manifestPath, manifestBytes);

  return {
    gameRoot: input.gameRoot,
    target: input.targetName,
    targetConfig: input.target,
    profile,
    manifest,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    outputDir,
    ...(profile.id === 'ait'
      ? {
          aitBrandIcon: input.target.icon?.externalUrl
            ?? 'generated/console-icon.png',
        }
      : {}),
  };
}

export async function verifyExistingTargetIcons(input: {
  readonly gameRoot: string;
  readonly targetName: string;
  readonly target: PlatformTargetConfig;
  readonly profile: string;
}): Promise<GeneratedTargetIcons> {
  const strict = input.profile === 'production';
  const loaded = loadGameBrandConfig(input.gameRoot);
  const appIcon = applyTargetIconOverride(loaded.appIcon, input.target.icon);
  const canonical = await validateBrandImage(
    resolveSecureGamePath(input.gameRoot, loaded.appIcon.source),
    { strict, minimumSize: 1024 },
  );
  const renderSource = await validateBrandImage(
    resolveSecureGamePath(input.gameRoot, appIcon.source),
    { strict, minimumSize: 1024 },
  );
  const profile = resolveTargetIconProfile(input.targetName, input.target);
  const backgroundColor = appIcon.backgroundColor ?? defaultBackgroundColor;
  const variantSources = await loadVariantSources(input.gameRoot, appIcon, strict);
  const sharedVariantSources = await loadVariantSources(input.gameRoot, loaded.appIcon, strict);
  const sharedConfigSha256 = createRenderConfigSha256({
    canonicalSourcePath: loaded.appIcon.source,
    appIcon: loaded.appIcon,
    backgroundColor: loaded.appIcon.backgroundColor ?? defaultBackgroundColor,
    canonical,
    renderSource: canonical,
    variantSources: sharedVariantSources,
    externalUrl: undefined,
  });
  const renderConfigSha256 = createRenderConfigSha256({
    canonicalSourcePath: loaded.appIcon.source,
    appIcon,
    backgroundColor,
    canonical,
    renderSource,
    variantSources,
    externalUrl: input.target.icon?.externalUrl,
  });
  const outputDir = resolveTargetOutputDir(
    input.gameRoot,
    canonical.sha256,
    profile.id,
    input.targetName,
  );
  const manifestPath = join(outputDir, 'icon-manifest.json');
  let manifestBytes: Buffer;

  try {
    manifestBytes = readFileSync(manifestPath);
  } catch {
    throw new Error(
      `Generated icons are missing for current source/profile: ${manifestPath}. Run the generate command.`,
    );
  }

  const manifest = JSON.parse(manifestBytes.toString('utf8')) as IconManifest;

  if (
    manifest.schemaVersion !== iconManifestSchemaVersion
    || manifest.generatorVersion !== iconGeneratorVersion
    || manifest.targetProfile !== profile.id
    || manifest.targetProfileVersion !== profile.version
    || manifest.canonicalSource?.sha256 !== canonical.sha256
    || manifest.renderSource?.sha256 !== renderSource.sha256
    || manifest.sharedConfigSha256 !== sharedConfigSha256
    || manifest.renderConfigSha256 !== renderConfigSha256
    || typeof manifest.variantSources !== 'object'
    || manifest.variantSources === null
    || !variantSourceEvidenceMatches(input.gameRoot, variantSources, manifest.variantSources)
    || !Array.isArray(manifest.outputs)
  ) {
    throw new Error(`Generated icon manifest is stale or incompatible: ${manifestPath}`);
  }

  const result: GeneratedTargetIcons = {
    gameRoot: input.gameRoot,
    target: input.targetName,
    targetConfig: input.target,
    profile,
    manifest,
    manifestPath,
    manifestSha256: sha256(manifestBytes),
    outputDir,
    ...(profile.id === 'ait'
      ? { aitBrandIcon: input.target.icon?.externalUrl ?? 'generated/console-icon.png' }
      : {}),
  };

  await verifyGeneratedTargetIcons(result);
  return result;
}

export async function verifyGeneratedTargetIcons(result: GeneratedTargetIcons): Promise<void> {
  const manifestBytes = readFileSync(result.manifestPath);

  if (sha256(manifestBytes) !== result.manifestSha256) {
    throw new Error(`Stale icon manifest: ${result.manifestPath}`);
  }

  assertManifestOutputsMatchProfile(result);

  for (const output of result.manifest.outputs) {
    const path = resolve(result.outputDir, output.path.slice('icons/'.length));
    const bytes = readFileSync(path);

    if (sha256(bytes) !== output.sha256) {
      throw new Error(`Stale generated icon output: ${path}`);
    }

    let metadata: Metadata;

    try {
      metadata = await sharp(bytes).metadata();
    } catch {
      throw new Error(`Generated icon is not a decodable PNG: ${path}`);
    }

    if (
      metadata.format !== 'png'
      || metadata.width !== output.width
      || metadata.height !== output.height
      || (metadata.pages ?? 1) !== 1
    ) {
      throw new Error(
        `Generated icon must be a ${output.width}x${output.height} single-page PNG: ${path}`,
      );
    }

    if (await pixelSha256(bytes) !== output.pixelSha256) {
      throw new Error(`Generated icon pixel digest mismatch: ${path}`);
    }

    if (output.opaque && !(await isPngOpaque(bytes))) {
      throw new Error(`Generated icon expected to be opaque: ${path}`);
    }

    if (result.profile.id === 'devvit' && bytes.byteLength > devvitIconMaximumBytes) {
      throw new Error(
        `Devvit marketing icon must be at most ${devvitIconMaximumBytes} bytes: ${path}`,
      );
    }
  }
}

export function inspectGeneratedTargetIcons(result: GeneratedTargetIcons): string {
  const lines = [
    `${result.target}: ${result.profile.id}@${result.profile.version}`,
    `  canonical ${result.manifest.canonicalSource.path} ${result.manifest.canonicalSource.sha256}`,
  ];

  if (result.manifest.renderSource.sha256 !== result.manifest.canonicalSource.sha256) {
    lines.push(
      `  override ${result.manifest.renderSource.path} ${result.manifest.renderSource.sha256}`,
    );
  }

  for (const output of result.manifest.outputs) {
    lines.push(
      `  ${output.purpose} ${output.width}x${output.height} ${output.opaque ? 'opaque' : 'alpha'} ${output.path}`,
    );
  }

  if (result.manifest.readiness !== undefined) {
    lines.push(
      `  readiness ${result.manifest.readiness.state}: ${result.manifest.readiness.message}`,
    );
  }

  return lines.join('\n');
}

async function resolveOutputImage(input: {
  readonly appIcon: BrandAppIconConfig;
  readonly output: IconOutputProfile;
  readonly renderSource: ValidatedBrandImage;
  readonly variantSources: Partial<Record<BrandImageVariant, ValidatedBrandImage>>;
}): Promise<ValidatedBrandImage | undefined> {
  if (input.output.sourceVariant === 'background' && input.appIcon.variants?.background === undefined) {
    return undefined;
  }

  return (
    (input.output.sourceVariant === undefined
      ? undefined
      : input.variantSources[input.output.sourceVariant])
    ?? (input.output.fallbackVariant === undefined
      ? undefined
      : input.variantSources[input.output.fallbackVariant])
    ?? input.renderSource
  );
}

async function loadVariantSources(
  gameRoot: string,
  appIcon: BrandAppIconConfig,
  strict: boolean,
): Promise<Partial<Record<BrandImageVariant, ValidatedBrandImage>>> {
  const entries = await Promise.all(
    brandImageVariants.map(async (variant) => {
      const path = appIcon.variants?.[variant];

      if (path === undefined) {
        return undefined;
      }

      return [
        variant,
        await validateBrandImage(resolveSecureGamePath(gameRoot, path), { strict }),
      ] as const;
    }),
  );

  return Object.fromEntries(
    entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
  );
}

function createRenderConfigSha256(input: {
  readonly canonicalSourcePath: string;
  readonly appIcon: BrandAppIconConfig;
  readonly backgroundColor: string;
  readonly canonical: ValidatedBrandImage;
  readonly renderSource: ValidatedBrandImage;
  readonly variantSources: Partial<Record<BrandImageVariant, ValidatedBrandImage>>;
  readonly externalUrl: string | undefined;
}): string {
  return sha256(JSON.stringify({
    canonicalSource: {
      path: input.canonicalSourcePath,
      sha256: input.canonical.sha256,
    },
    renderSource: {
      path: input.appIcon.source,
      sha256: input.renderSource.sha256,
    },
    backgroundColor: input.backgroundColor,
    externalUrl: input.externalUrl ?? null,
    variants: Object.fromEntries(
      brandImageVariants.map((variant) => [
        variant,
        input.variantSources[variant] === undefined
          ? null
          : {
              path: input.appIcon.variants?.[variant],
              sha256: input.variantSources[variant].sha256,
            },
      ]),
    ),
  }));
}

function variantSourceEvidenceMatches(
  gameRoot: string,
  expected: Partial<Record<BrandImageVariant, ValidatedBrandImage>>,
  actual: Partial<Record<BrandImageVariant, IconManifest['canonicalSource']>>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = brandImageVariants
    .filter((variant) => expected[variant] !== undefined)
    .sort();

  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }

  return expectedKeys.every((variant) => {
    const image = expected[variant];
    const source = actual[variant];

    return image !== undefined
      && source !== undefined
      && source.path === toGameRelativePath(gameRoot, image.path)
      && source.sha256 === image.sha256
      && source.format === image.format;
  });
}

async function assertOpaqueBackgroundColor(backgroundColor: string): Promise<void> {
  let pixel: Buffer;

  try {
    pixel = await sharp({
      create: { width: 1, height: 1, channels: 4, background: backgroundColor },
    }).ensureAlpha().raw().toBuffer();
  } catch (error) {
    throw new Error(`Invalid app icon backgroundColor ${backgroundColor}: ${formatError(error)}`);
  }

  if (pixel[3] !== 255) {
    throw new Error(
      'App icon backgroundColor must be fully opaque for the selected target profile.',
    );
  }
}

function assertManifestOutputsMatchProfile(result: GeneratedTargetIcons): void {
  const expectedOutputs = result.profile.outputs.filter(
    (output) =>
      output.requiredVariant !== true
      || (output.sourceVariant !== undefined
        && result.manifest.variantSources[output.sourceVariant] !== undefined),
  );

  if (result.manifest.outputs.length !== expectedOutputs.length) {
    throw new Error(`Generated icon output count does not match ${result.profile.id} profile.`);
  }

  for (const expected of expectedOutputs) {
    const path = `icons/${expected.file}`;
    const matches = result.manifest.outputs.filter((output) => output.path === path);

    if (matches.length !== 1) {
      throw new Error(`Generated icon manifest must contain exactly one ${path} output.`);
    }

    const output = matches[0];

    if (
      output === undefined
      || output.target !== result.target
      || output.purpose !== expected.purpose
      || output.width !== expected.width
      || output.height !== expected.height
      || output.format !== 'png'
      || output.opaque !== expected.opaque
      || !/^[0-9a-f]{64}$/u.test(output.sha256)
      || !/^[0-9a-f]{64}$/u.test(output.pixelSha256)
    ) {
      throw new Error(`Generated icon manifest output does not match profile: ${path}`);
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function renderSolidBackground(
  output: IconOutputProfile,
  backgroundColor: string,
): Promise<Buffer> {
  return sharp({
    create: {
      width: output.width,
      height: output.height,
      channels: 4,
      background: backgroundColor,
    },
  }).toColourspace('srgb').png({ compressionLevel: 9, effort: 10 }).toBuffer();
}

function toManifestSource(
  gameRoot: string,
  image: ValidatedBrandImage,
): IconManifest['canonicalSource'] {
  return {
    path: toGameRelativePath(gameRoot, image.path),
    sha256: image.sha256,
    format: image.format,
  };
}

function createReadiness(
  input: {
    readonly targetName: string;
    readonly target: PlatformTargetConfig;
    readonly profile: string;
    readonly enforceExternalReadiness?: boolean;
  },
  outputs: readonly IconManifestOutput[],
  externalUrl: string | undefined,
): IconManifest['readiness'] | undefined {
  if (input.target.kind !== 'apps-in-toss') {
    return undefined;
  }

  if (externalUrl !== undefined) {
    let url: URL;

    try {
      url = new URL(externalUrl);
    } catch {
      throw new Error(`${input.targetName}.icon.externalUrl must be a valid HTTPS URL.`);
    }

    if (url.protocol !== 'https:' || url.hostname.length === 0) {
      throw new Error(`${input.targetName}.icon.externalUrl must use https.`);
    }

    return {
      state: 'ready',
      message: 'Apps in Toss console icon URL configured.',
      externalUrl,
    };
  }

  if (input.enforceExternalReadiness === true) {
    throw new Error(
      `${input.targetName}.icon.externalUrl is required for a production Apps in Toss package. Upload ${requireOutput(outputs, 'console-icon').path} in the Apps in Toss console first.`,
    );
  }

  return {
    state: 'console-upload-required',
    message: `Upload ${requireOutput(outputs, 'console-icon').path} in the Apps in Toss console and configure icon.externalUrl before production packaging.`,
  };
}

function requireOutput(
  outputs: readonly IconManifestOutput[],
  purpose: string,
): IconManifestOutput {
  const output = outputs.find((candidate) => candidate.purpose === purpose);

  if (output === undefined) {
    throw new Error(`Icon profile did not generate required ${purpose} output.`);
  }

  return output;
}

function safePathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '');

  if (segment.length === 0 || segment === '.' || segment === '..') {
    throw new Error(`Target name is not safe for generated icon paths: ${value}`);
  }

  return segment;
}

function resolveTargetOutputDir(
  gameRoot: string,
  canonicalSha256: string,
  profileId: string,
  targetName: string,
): string {
  return resolve(
    gameRoot,
    '.mpgd/generated/icons',
    canonicalSha256,
    profileId,
    safePathSegment(targetName),
  );
}

function assertSafeGeneratedPath(gameRoot: string, outputDir: string): void {
  const root = realpathSync(gameRoot);
  const relativePath = relative(resolve(gameRoot), outputDir);

  if (relativePath.startsWith('..') || relativePath.length === 0) {
    throw new Error(`Generated icon path escapes the game root: ${outputDir}`);
  }

  let current = root;

  for (const segment of relativePath.split(/[\\/]+/u)) {
    current = resolve(current, segment);

    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Generated icon path may not traverse a symlink: ${current}`);
    }
  }
}
