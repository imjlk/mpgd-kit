import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

import { formatError, readBoundedUtf8File } from './evidence-io.js';
import {
  type MicrosoftStoreSubmissionEvidenceInput,
  type PreparedMicrosoftStorePackageGenerationInput,
  type RunMicrosoftStorePackageGenerationInput,
} from './microsoft-store-package-generation-contract.js';
import {
  assertMicrosoftStoreSnapshotUnchanged,
  hashMicrosoftStoreFileSnapshot,
} from './microsoft-store-package-generation-integrity.js';
import {
  assertMicrosoftStorePwaUrlInsideManifestScope,
  readHashVerifiedMicrosoftStoreManifest,
} from './microsoft-store-package-generation-manifest.js';

const maximumSubmissionEvidenceBytes = 4 * 1024 * 1024;

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
  const submissionEvidence = readSubmissionEvidence(submissionEvidenceFile, gameRoot);
  const manifestBefore = hashMicrosoftStoreFileSnapshot(
    submissionEvidence.manifestFile,
    'Microsoft Store web app manifest',
  );

  if (manifestBefore.sha256 !== submissionEvidence.manifestSha256) {
    throw new Error(
      `Microsoft Store web app manifest SHA-256 must match submission evidence: expected ${submissionEvidence.manifestSha256}, received ${manifestBefore.sha256}.`,
    );
  }

  const submission: MicrosoftStoreSubmissionEvidenceInput = {
    ...submissionEvidence,
    manifest: readHashVerifiedMicrosoftStoreManifest(
      submissionEvidence.manifestFile,
      manifestBefore,
    ),
  };

  const pwaUrl = requirePublicHttpsUrl(input.pwaUrl, 'Microsoft Store PWA URL');
  const manifestUrl = requirePublicHttpsUrl(input.manifestUrl, 'Microsoft Store manifest URL');
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
  assertDistinctFiles([
    { file: outputFile, label: 'package ZIP' },
    { file: jsonFile, label: 'package generation JSON' },
    { file: markdownFile, label: 'package generation Markdown' },
    { file: submissionEvidenceFile, label: 'submission evidence' },
    { file: submission.manifestFile, label: 'web app manifest' },
  ]);

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
}

function readSubmissionEvidence(
  file: string,
  gameRoot: string,
): Omit<MicrosoftStoreSubmissionEvidenceInput, 'manifest'> {
  const source = readBoundedUtf8File(file, maximumSubmissionEvidenceBytes);

  if (source === null) {
    throw new Error('Microsoft Store submission evidence is too large.');
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
  const listing = requireRecord(root.listing, 'Microsoft Store listing evidence');
  const locales = requireRecord(listing.locales, 'Microsoft Store listing locales');
  const resourceLanguages = Object.keys(locales).sort(compareCodeUnits);

  if (resourceLanguages.length === 0) {
    throw new Error('Microsoft Store submission evidence must contain a listing locale.');
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
    resourceLanguage: resourceLanguages.join(','),
  };
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

  if (existsSync(resolved)) {
    const metadata = lstatSync(resolved);

    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`${label} must be a regular file when it already exists: ${resolved}`);
    }
  }

  return resolved;
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
          fileMetadata.dev === candidateMetadata.dev
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

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
