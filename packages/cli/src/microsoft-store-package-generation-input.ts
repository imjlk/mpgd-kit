import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { formatError } from './evidence-io.js';
import {
  type MicrosoftStoreManifestIconInput,
  type MicrosoftStoreSubmissionEvidenceInput,
  type PreparedMicrosoftStorePackageGenerationInput,
  type RunMicrosoftStorePackageGenerationInput,
} from './microsoft-store-package-generation-contract.js';
import {
  assertMicrosoftStoreSnapshotUnchanged,
  hashMicrosoftStoreBytes,
  hashMicrosoftStoreFileSnapshot,
  readBoundedMicrosoftStoreFileBytes,
} from './microsoft-store-package-generation-integrity.js';
import {
  assertMicrosoftStorePwaUrlInsideManifestScope,
  readHashVerifiedMicrosoftStoreManifest,
} from './microsoft-store-package-generation-manifest.js';

const maximumSubmissionEvidenceBytes = 4 * 1024 * 1024;
const maximumManifestIcons = 32;
const maximumManifestIconBytes = 2 * 1024 * 1024;

export function prepareMicrosoftStorePackageGenerationInput(
  input: RunMicrosoftStorePackageGenerationInput,
): PreparedMicrosoftStorePackageGenerationInput {
  const gameRoot = readCanonicalDirectory(input.gameRoot, 'game root');
  const submissionEvidenceFile = readCanonicalFileInside(
    gameRoot,
    input.submissionEvidenceFile,
    'Microsoft Store submission evidence',
  );
  const submissionBefore = hashMicrosoftStoreFileSnapshot(
    submissionEvidenceFile,
    'Microsoft Store submission evidence',
  );
  const submissionEvidence = readSubmissionEvidence(
    submissionEvidenceFile,
    gameRoot,
    submissionBefore,
  );
  const manifestBefore = hashMicrosoftStoreFileSnapshot(
    submissionEvidence.manifestFile,
    'Microsoft Store web app manifest',
  );

  if (manifestBefore.sha256 !== submissionEvidence.manifestSha256) {
    throw new Error(
      `Microsoft Store web app manifest SHA-256 must match submission evidence: expected ${submissionEvidence.manifestSha256}, received ${manifestBefore.sha256}.`,
    );
  }

  const manifest = readHashVerifiedMicrosoftStoreManifest(
    submissionEvidence.manifestFile,
    manifestBefore,
  );
  const pwaUrl = requirePublicHttpsUrl(input.pwaUrl, 'Microsoft Store PWA URL');
  const manifestUrl = requirePublicHttpsUrl(input.manifestUrl, 'Microsoft Store manifest URL');
  const submission: MicrosoftStoreSubmissionEvidenceInput = {
    ...submissionEvidence,
    manifest,
    manifestIcons: prepareManifestIcons(
      gameRoot,
      manifestUrl,
      manifest,
      submissionEvidence.manifestIcons,
    ),
  };

  assertMicrosoftStorePwaUrlInsideManifestScope(pwaUrl, manifestUrl, submission.manifest);
  const modernVersion = requireStorePackageVersion(input.modernVersion, 'modern package version');
  const classicVersion = requireStorePackageVersion(
    input.classicVersion,
    'classic package version',
  );

  if (compareVersions(classicVersion, modernVersion) >= 0) {
    throw new Error('Microsoft Store classic package version must be lower than modern version.');
  }

  const outputFile = prepareMissingOutputFile(gameRoot, input.outputFile, 'package ZIP');
  const jsonFile = resolveEvidenceFile(gameRoot, input.jsonFile, 'package generation JSON');
  const markdownFile = resolveEvidenceFile(
    gameRoot,
    input.markdownFile,
    'package generation Markdown',
  );
  const filesThatMustAlwaysBeDistinct = [
    { file: outputFile, label: 'package ZIP' },
    { file: jsonFile, label: 'package generation JSON' },
    { file: markdownFile, label: 'package generation Markdown' },
    { file: submissionEvidenceFile, label: 'submission evidence' },
    { file: submission.manifestFile, label: 'web app manifest' },
  ];
  assertDistinctFiles(filesThatMustAlwaysBeDistinct);

  for (const [index, icon] of submission.manifestIcons.entries()) {
    assertDistinctFiles([
      ...filesThatMustAlwaysBeDistinct,
      { file: icon.file, label: `web app manifest icon[${index}]` },
    ]);
  }

  return {
    gameRoot,
    submissionEvidenceFile,
    submissionBefore,
    submission,
    manifestBefore,
    pwaUrl,
    manifestUrl,
    modernVersion,
    classicVersion,
    outputFile,
    jsonFile,
    markdownFile,
  };
}

export function assertMicrosoftStorePackageGenerationInputUnchanged(
  input: PreparedMicrosoftStorePackageGenerationInput,
): void {
  assertMicrosoftStoreSnapshotUnchanged(
    input.submissionEvidenceFile,
    input.submissionBefore,
    'Microsoft Store submission evidence changed during package generation',
  );
  assertMicrosoftStoreSnapshotUnchanged(
    input.submission.manifestFile,
    input.manifestBefore,
    'Microsoft Store web app manifest changed during package generation',
  );

  for (const [index, icon] of input.submission.manifestIcons.entries()) {
    assertMicrosoftStoreSnapshotUnchanged(
      icon.file,
      icon.snapshot,
      `Microsoft Store web app manifest icon[${index}] changed during package generation`,
    );
  }
}

function readSubmissionEvidence(
  file: string,
  gameRoot: string,
  expected: PreparedMicrosoftStorePackageGenerationInput['submissionBefore'],
): Omit<MicrosoftStoreSubmissionEvidenceInput, 'manifest'> {
  const bytes = readBoundedMicrosoftStoreFileBytes(
    file,
    'Microsoft Store submission evidence',
    maximumSubmissionEvidenceBytes,
  );

  if (bytes === null) {
    throw new Error('Microsoft Store submission evidence is too large.');
  }

  if (bytes.length !== expected.sizeBytes || hashMicrosoftStoreBytes(bytes) !== expected.sha256) {
    throw new Error(`Microsoft Store submission evidence changed while it was read: ${file}`);
  }

  assertMicrosoftStoreSnapshotUnchanged(
    file,
    expected,
    'Microsoft Store submission evidence changed while it was parsed',
  );
  let source: string;

  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `Microsoft Store submission evidence must use valid UTF-8: ${formatError(error)}`,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Failed to parse Microsoft Store submission evidence: ${formatError(error)}`);
  }

  const root = requireRecord(parsed, 'Microsoft Store submission evidence');

  if (root.schemaVersion !== 1 || root.target !== 'microsoft-store') {
    throw new Error(
      'Microsoft Store submission evidence must use schemaVersion 1 and target microsoft-store.',
    );
  }

  const identity = requireRecord(root.productIdentity, 'Microsoft Store product identity');
  const manifest = requireRecord(root.manifest, 'Microsoft Store manifest evidence');
  const manifestIcons = requireArray(manifest.icons, 'Microsoft Store manifest icon evidence');
  const manifestIconCount = requirePositiveInteger(
    manifest.iconCount,
    'Microsoft Store manifest icon evidence count',
  );
  const listing = requireRecord(root.listing, 'Microsoft Store listing evidence');
  const locales = requireRecord(listing.locales, 'Microsoft Store listing locales');
  const resourceLanguages = Object.keys(locales).sort(compareCodeUnits);

  if (resourceLanguages.length === 0) {
    throw new Error('Microsoft Store submission evidence must contain a listing locale.');
  }

  if (
    manifestIcons.length === 0
    || manifestIcons.length > maximumManifestIcons
    || manifestIconCount !== manifestIcons.length
  ) {
    throw new Error(
      `Microsoft Store manifest icon evidence must contain 1-${maximumManifestIcons} entries and match iconCount.`,
    );
  }

  return {
    identity: {
      packageId: requireNonEmptyString(identity.packageId, 'Microsoft Store package ID'),
      publisherId: requireNonEmptyString(identity.publisherId, 'Microsoft Store publisher ID'),
      publisherDisplayName: requireNonEmptyString(
        identity.publisherDisplayName,
        'Microsoft Store publisher display name',
      ),
      reservedName: requireNonEmptyString(identity.reservedName, 'Microsoft Store reserved name'),
    },
    manifestFile: readCanonicalFileInside(
      gameRoot,
      path.resolve(gameRoot, requireNonEmptyString(manifest.file, 'manifest evidence file')),
      'Microsoft Store web app manifest',
    ),
    manifestSha256: requireSha256(manifest.sha256, 'manifest evidence SHA-256'),
    manifestIcons: manifestIcons.map((icon, index) => {
      const record = requireRecord(icon, `Microsoft Store manifest icon evidence[${index}]`);
      const iconFile = readCanonicalFileInside(
        gameRoot,
        path.resolve(
          gameRoot,
          requireNonEmptyString(
            record.file,
            `Microsoft Store manifest icon evidence[${index}].file`,
          ),
        ),
        `Microsoft Store web app manifest icon[${index}]`,
      );
      const snapshot = hashMicrosoftStoreFileSnapshot(
        iconFile,
        `Microsoft Store web app manifest icon[${index}]`,
      );
      const expectedSha256 = requireSha256(
        record.sha256,
        `Microsoft Store manifest icon evidence[${index}].sha256`,
      );

      if (snapshot.sizeBytes > maximumManifestIconBytes) {
        throw new Error(
          `Microsoft Store web app manifest icon[${index}] exceeds the ${maximumManifestIconBytes}-byte size limit.`,
        );
      }

      if (snapshot.sha256 !== expectedSha256) {
        throw new Error(
          `Microsoft Store web app manifest icon[${index}] SHA-256 must match submission evidence: expected ${expectedSha256}, received ${snapshot.sha256}.`,
        );
      }

      return {
        file: iconFile,
        url: '',
        snapshot,
        width: requirePositiveInteger(
          record.width,
          `Microsoft Store manifest icon evidence[${index}].width`,
        ),
        height: requirePositiveInteger(
          record.height,
          `Microsoft Store manifest icon evidence[${index}].height`,
        ),
      };
    }),
    resourceLanguage: resourceLanguages.join(','),
  };
}

function prepareManifestIcons(
  gameRoot: string,
  manifestUrl: string,
  manifest: Readonly<Record<string, unknown>>,
  evidenceIcons: readonly MicrosoftStoreManifestIconInput[],
): readonly MicrosoftStoreManifestIconInput[] {
  const manifestIcons = requireArray(manifest.icons, 'Microsoft Store web app manifest icons');

  if (manifestIcons.length !== evidenceIcons.length) {
    throw new Error(
      'Microsoft Store web app manifest icons must match submission evidence by index.',
    );
  }

  return manifestIcons.map((icon, index) => {
    const record = requireRecord(icon, `Microsoft Store web app manifest icons[${index}]`);
    const src = requireNonEmptyString(
      record.src,
      `Microsoft Store web app manifest icons[${index}].src`,
    );
    let resolvedUrl: string;

    try {
      resolvedUrl = new URL(src, manifestUrl).href;
    } catch {
      throw new Error(
        `Microsoft Store web app manifest icons[${index}].src must resolve against the deployed manifest URL.`,
      );
    }

    const evidence = evidenceIcons[index];

    if (evidence === undefined) {
      throw new Error(`Microsoft Store manifest icon evidence[${index}] is missing.`);
    }

    assertInside(gameRoot, evidence.file, `Microsoft Store web app manifest icon[${index}]`);
    const dimensions = requireManifestIconDimensions(
      record.sizes,
      `Microsoft Store web app manifest icons[${index}].sizes`,
    );

    if (evidence.width !== dimensions.width || evidence.height !== dimensions.height) {
      throw new Error(
        `Microsoft Store manifest icon evidence[${index}] dimensions must match the hash-verified web app manifest: expected ${dimensions.width}x${dimensions.height}, received ${evidence.width}x${evidence.height}.`,
      );
    }

    return {
      ...evidence,
      url: requirePublicHttpsUrl(
        resolvedUrl,
        `Microsoft Store deployed manifest icon[${index}] URL`,
      ),
    };
  });
}

function requirePublicHttpsUrl(input: string, label: string): string {
  const value = requireNonEmptyString(input, label);
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a public HTTPS URL.`);
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
  const unbracketedHostname = hostname.replace(/^\[|\]$/gu, '');

  if (
    url.protocol !== 'https:'
    || url.username.length > 0
    || url.password.length > 0
    || url.hash.length > 0
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || ['invalid', 'test', 'example'].some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
    || isIP(unbracketedHostname) !== 0
  ) {
    throw new Error(`${label} must be a public HTTPS URL without credentials or a fragment.`);
  }

  return url.href;
}

function requireStorePackageVersion(input: string, label: string): string {
  const value = requireNonEmptyString(input, label);
  const parts = value.split('.');

  if (
    (parts.length !== 3 && parts.length !== 4)
    || parts.some((part) => !/^(?:0|[1-9][0-9]{0,4})$/u.test(part))
  ) {
    throw new Error(`${label} must use three numeric parts or four parts ending in .0.`);
  }

  const numbers = parts.map(Number);

  if (
    numbers[0] === 0
    || numbers.some((part) => part > 65_535)
    || (numbers[3] ?? 0) !== 0
  ) {
    throw new Error(
      `${label} must start from 1, keep every part at or below 65535, and end in .0.`,
    );
  }

  return parts.length === 3 ? `${value}.0` : value;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);

  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function prepareMissingOutputFile(root: string, input: string, label: string): string {
  const resolved = resolvePotentiallyMissingPath(input);
  assertInside(root, resolved, label);

  if (path.extname(resolved).toLowerCase() !== '.zip') {
    throw new Error(`${label} must use a .zip extension.`);
  }

  if (existsSync(resolved)) {
    throw new Error(`${label} must not already exist: ${resolved}`);
  }

  mkdirSync(path.dirname(resolved), { recursive: true });
  const parent = realpathSync(path.dirname(resolved));
  assertInside(root, parent, `${label} directory`);
  return path.join(parent, path.basename(resolved));
}

function resolveEvidenceFile(root: string, input: string, label: string): string {
  const resolved = resolvePotentiallyMissingPath(input);
  assertInside(root, resolved, label);
  const metadata = lstatIfExists(resolved, label);

  if (metadata !== undefined && (metadata.isSymbolicLink() || !metadata.isFile())) {
    throw new Error(`${label} must be a regular file when it already exists: ${resolved}`);
  }

  return resolved;
}

function lstatIfExists(file: string, label: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }

    throw new Error(`Failed to inspect ${label}: ${file} (${formatError(error)})`);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function resolvePotentiallyMissingPath(input: string): string {
  const resolved = path.resolve(input);
  let ancestor = resolved;

  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);

    if (parent === ancestor) {
      throw new Error(`Could not find an existing ancestor for output path: ${resolved}`);
    }

    ancestor = parent;
  }

  return path.resolve(realpathSync(ancestor), path.relative(ancestor, resolved));
}

function readCanonicalDirectory(input: string, label: string): string {
  let canonical: string;

  try {
    canonical = realpathSync(input);
  } catch (error) {
    throw new Error(`${label} must exist: ${input} (${formatError(error)})`);
  }

  if (!lstatSync(canonical).isDirectory()) {
    throw new Error(`${label} must be a directory: ${canonical}`);
  }

  return canonical;
}

function readCanonicalFile(input: string, label: string): string {
  let canonical: string;

  try {
    canonical = realpathSync(input);
  } catch (error) {
    throw new Error(`${label} must exist: ${input} (${formatError(error)})`);
  }

  if (!lstatSync(canonical).isFile()) {
    throw new Error(`${label} must be a regular file: ${canonical}`);
  }

  return canonical;
}

function readCanonicalFileInside(root: string, input: string, label: string): string {
  const canonical = readCanonicalFile(input, label);
  assertInside(root, canonical, label);
  return canonical;
}

function assertDistinctFiles(
  files: readonly { readonly file: string; readonly label: string }[],
): void {
  for (const [index, file] of files.entries()) {
    for (const candidate of files.slice(index + 1)) {
      if (path.relative(file.file, candidate.file).length === 0) {
        throw new Error(`${file.label} must not alias ${candidate.label}: ${file.file}`);
      }

      if (existsSync(file.file) && existsSync(candidate.file)) {
        const fileMetadata = statSync(file.file);
        const candidateMetadata = statSync(candidate.file);

        if (
          // Windows may report ino=0, which means file identity is unavailable rather than equal.
          fileMetadata.ino !== 0
          && fileMetadata.dev === candidateMetadata.dev
          && fileMetadata.ino === candidateMetadata.ino
        ) {
          throw new Error(`${file.label} must not alias ${candidate.label}: ${file.file}`);
        }
      }
    }
  }
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);

  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the game root: ${root}`);
  }
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }

  return input as Record<string, unknown>;
}

function requireArray(input: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array.`);
  }

  return input;
}

function requireNonEmptyString(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
    throw new Error(`${label} must be a non-empty string without surrounding whitespace.`);
  }

  return input;
}

function requireSha256(input: unknown, label: string): string {
  const value = requireNonEmptyString(input, label).toLowerCase();

  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must contain 64 hexadecimal characters.`);
  }

  return value;
}

function requirePositiveInteger(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return input;
}

function requireManifestIconDimensions(
  input: unknown,
  label: string,
): { readonly width: number; readonly height: number } {
  const value = requireNonEmptyString(input, label);
  const match = /^(\d+)x(\d+)$/u.exec(value);

  if (match === null) {
    throw new Error(`${label} must declare one width and height in pixels.`);
  }

  const width = Number(match[1]);
  const height = Number(match[2]);

  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error(`${label} must declare positive safe-integer dimensions.`);
  }

  return { width, height };
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
