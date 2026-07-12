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

import sharp from 'sharp';

import type { PlatformTargetConfig } from '../target/schemas';
import {
  applyTargetIconOverride,
  loadGameBrandConfig,
  resolveSecureGamePath,
  toGameRelativePath,
} from './config';
import {
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
  type GeneratedTargetIcons,
  type IconManifest,
  type IconManifestOutput,
  type IconOutputProfile,
} from './types';

const defaultBackgroundColor = '#ffffff';

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
  const warnings = [...loaded.warnings, ...canonical.warnings, ...renderSource.warnings];

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
      gameRoot: input.gameRoot,
      appIcon,
      output,
      renderSource,
      strict,
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
    generatorVersion: iconGeneratorVersion,
    targetProfile: profile.id,
    targetProfileVersion: profile.version,
    outputs,
    warnings,
    ...(readiness === undefined ? {} : { readiness }),
  };
  const manifestPath = join(outputDir, 'icon-manifest.json');
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;

  writeFileSync(manifestPath, manifestBytes);

  if (profile.id === 'devvit') {
    const output = requireOutput(outputs, 'app-icon');
    const size = readFileSync(resolve(outputDir, output.path.slice('icons/'.length))).byteLength;

    if (size > 500_000) {
      throw new Error(
        `Devvit marketing icon is ${size} bytes; the generated 1024x1024 PNG must be at most 500000 bytes.`,
      );
    }
  }

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

  verifyGeneratedTargetIcons(result);
  return result;
}

export function verifyGeneratedTargetIcons(result: GeneratedTargetIcons): void {
  const manifestBytes = readFileSync(result.manifestPath);

  if (sha256(manifestBytes) !== result.manifestSha256) {
    throw new Error(`Stale icon manifest: ${result.manifestPath}`);
  }

  for (const output of result.manifest.outputs) {
    const path = resolve(result.outputDir, output.path.slice('icons/'.length));
    const bytes = readFileSync(path);

    if (sha256(bytes) !== output.sha256) {
      throw new Error(`Stale generated icon output: ${path}`);
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
  readonly gameRoot: string;
  readonly appIcon: BrandAppIconConfig;
  readonly output: IconOutputProfile;
  readonly renderSource: ValidatedBrandImage;
  readonly strict: boolean;
}): Promise<ValidatedBrandImage | undefined> {
  if (input.output.sourceVariant === 'background' && input.appIcon.variants?.background === undefined) {
    return undefined;
  }

  const configuredPath = input.output.sourceVariant === undefined
    ? undefined
    : input.appIcon.variants?.[input.output.sourceVariant];
  const fallbackPath = input.output.fallbackVariant === undefined
    ? undefined
    : input.appIcon.variants?.[input.output.fallbackVariant];
  const selectedPath = configuredPath ?? fallbackPath;

  if (selectedPath === undefined) {
    return input.renderSource;
  }

  return validateBrandImage(resolveSecureGamePath(input.gameRoot, selectedPath), {
    strict: input.strict,
  });
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
    if (!/^https:\/\//u.test(externalUrl)) {
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
