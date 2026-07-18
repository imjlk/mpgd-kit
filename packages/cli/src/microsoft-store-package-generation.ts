import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';

import {
  escapeMarkdownInline,
  escapeMarkdownTable,
  formatError,
  relativeOrAbsolute,
} from './evidence-io.js';
import {
  microsoftStorePackageGenerationSchemaVersion,
  microsoftStorePackageGeneratorEndpoint,
  microsoftStorePackageGeneratorSourceRevision,
  type MicrosoftStoreFileSnapshot,
  type MicrosoftStorePackageGenerationEvidence,
  type MicrosoftStorePackageGenerationRuntime,
  type MicrosoftStorePackageGeneratorRequest,
  type RunMicrosoftStorePackageGenerationInput,
} from './microsoft-store-package-generation-contract.js';
import {
  createMicrosoftStorePackageGenerationRuntime,
  withMicrosoftStorePackageArchive,
} from './microsoft-store-package-generation-download.js';
import {
  assertMicrosoftStorePackageGenerationInputUnchanged,
  prepareMicrosoftStorePackageGenerationInput,
} from './microsoft-store-package-generation-input.js';
import {
  hashMicrosoftStoreBytes,
  hashMicrosoftStoreFileSnapshot,
} from './microsoft-store-package-generation-integrity.js';

export {
  microsoftStorePackageGenerationSchemaVersion,
  microsoftStorePackageGeneratorEndpoint,
  microsoftStorePackageGeneratorSourceRevision,
  type CreateMicrosoftStorePackageGenerationRuntimeInput,
  type MicrosoftStoreAddressResolver,
  type MicrosoftStorePackageGenerationEvidence,
  type MicrosoftStorePackageGenerationRuntime,
  type MicrosoftStoreResolvedAddress,
  type RunMicrosoftStorePackageGenerationInput,
} from './microsoft-store-package-generation-contract.js';

export { createMicrosoftStorePackageGenerationRuntime } from './microsoft-store-package-generation-download.js';

export async function runMicrosoftStorePackageGeneration(
  input: RunMicrosoftStorePackageGenerationInput,
  runtime: MicrosoftStorePackageGenerationRuntime =
    createMicrosoftStorePackageGenerationRuntime(),
): Promise<MicrosoftStorePackageGenerationEvidence> {
  const prepared = prepareMicrosoftStorePackageGenerationInput(input);
  const request: MicrosoftStorePackageGeneratorRequest = {
    name: prepared.submission.identity.reservedName,
    packageId: prepared.submission.identity.packageId,
    applicationId: 'App',
    url: prepared.pwaUrl,
    version: prepared.modernVersion,
    allowSigning: true,
    publisher: {
      displayName: prepared.submission.identity.publisherDisplayName,
      commonName: prepared.submission.identity.publisherId,
    },
    generateModernPackage: true,
    classicPackage: {
      generate: true,
      version: prepared.classicVersion,
      url: prepared.pwaUrl,
    },
    edgeChannel: 'stable',
    manifestUrl: prepared.manifestUrl,
    manifest: prepared.submission.manifest,
    resourceLanguage: prepared.submission.resourceLanguage,
    targetDeviceFamilies: ['Desktop'],
    usePwaBuilderWithCustomManifest: true,
  };
  const requestBody = JSON.stringify(request);
  const requestSha256 = hashMicrosoftStoreBytes(Buffer.from(requestBody));

  return withMicrosoftStorePackageArchive(
    {
      runtime,
      manifestUrl: prepared.manifestUrl,
      manifestSha256: prepared.submission.manifestSha256,
      manifestIcons: prepared.submission.manifestIcons,
      requestBody,
      outputFile: prepared.outputFile,
      assertInputsUnchanged: () => {
        assertMicrosoftStorePackageGenerationInputUnchanged(prepared);
      },
    },
    (archive) => {
      const evidence: MicrosoftStorePackageGenerationEvidence = {
        schemaVersion: microsoftStorePackageGenerationSchemaVersion,
        target: 'microsoft-store',
        pwaUrl: prepared.pwaUrl,
        modernVersion: prepared.modernVersion,
        classicVersion: prepared.classicVersion,
        submissionEvidenceFile: relativeOrAbsolute(
          prepared.gameRoot,
          prepared.submissionEvidenceFile,
        ),
        submissionEvidenceSha256: prepared.submissionBefore.sha256,
        productIdentity: prepared.submission.identity,
        manifest: {
          file: relativeOrAbsolute(prepared.gameRoot, prepared.submission.manifestFile),
          url: prepared.manifestUrl,
          sha256: prepared.submission.manifestSha256,
          pinnedInGeneratorRequest: true,
          icons: {
            count: prepared.submission.manifestIcons.length,
            verification: 'before-and-after-generator',
            entries: prepared.submission.manifestIcons.map((icon) => ({
              file: relativeOrAbsolute(prepared.gameRoot, icon.file),
              url: icon.url,
              sha256: icon.snapshot.sha256,
              width: icon.width,
              height: icon.height,
            })),
          },
        },
        generator: {
          endpoint: microsoftStorePackageGeneratorEndpoint,
          sourceRevision: microsoftStorePackageGeneratorSourceRevision,
          contract: 'unversioned-best-effort',
          requestSha256,
        },
        archive: {
          file: relativeOrAbsolute(prepared.gameRoot, prepared.outputFile),
          sizeBytes: archive.sizeBytes,
          sha256: archive.sha256,
          contentType: 'application/zip',
        },
        packageInspectionRequired: true,
      };

      mkdirSync(path.dirname(prepared.jsonFile), { recursive: true });
      mkdirSync(path.dirname(prepared.markdownFile), { recursive: true });
      writeMicrosoftStorePackageGenerationEvidenceFiles({
        jsonFile: prepared.jsonFile,
        markdownFile: prepared.markdownFile,
        report: evidence,
        markdown: renderMicrosoftStorePackageGenerationMarkdown(evidence),
      });

      return evidence;
    },
  );
}

interface MicrosoftStoreEvidenceFilePublication {
  readonly finalFile: string;
  readonly temporaryFile: string;
  readonly backupFile: string;
  readonly lockFile: string;
  readonly contents: string;
  readonly contentsSnapshot: MicrosoftStoreFileSnapshot;
  temporaryExists: boolean;
  backupExists: boolean;
  lockIdentity?: MicrosoftStoreFileNodeIdentity;
  lockToken?: string;
  previousIdentity?: MicrosoftStoreEvidenceFileIdentity;
  publishedIdentity?: MicrosoftStoreEvidenceFileIdentity;
}

interface MicrosoftStoreFileNodeIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface MicrosoftStoreEvidenceFileIdentity
  extends MicrosoftStoreFileNodeIdentity, MicrosoftStoreFileSnapshot {
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function writeMicrosoftStorePackageGenerationEvidenceFiles(input: {
  readonly jsonFile: string;
  readonly markdownFile: string;
  readonly report: unknown;
  readonly markdown: string;
}): void {
  const transactionId = `${process.pid}.${randomUUID()}`;
  const files: MicrosoftStoreEvidenceFilePublication[] = [
    createEvidenceFilePublication(
      input.jsonFile,
      `${JSON.stringify(input.report, null, 2)}\n`,
      transactionId,
    ),
    createEvidenceFilePublication(input.markdownFile, input.markdown, transactionId),
  ];
  let completed = false;

  try {
    for (const file of files) {
      acquireEvidenceFileLock(file, transactionId);
    }

    for (const file of files) {
      const descriptor = openSync(file.temporaryFile, 'wx', 0o600);
      file.temporaryExists = true;

      try {
        writeFileSync(descriptor, file.contents);
      } finally {
        closeSync(descriptor);
      }
    }

    for (const file of files) {
      const metadata = lstatIfExists(file.finalFile);

      if (metadata === undefined) {
        continue;
      }

      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(
          `Microsoft Store package generation evidence must be a regular file: ${file.finalFile}`,
        );
      }

      copyFileSync(file.finalFile, file.backupFile, fsConstants.COPYFILE_EXCL);
      file.backupExists = true;
      const backupSnapshot = hashMicrosoftStoreFileSnapshot(
        file.backupFile,
        'Microsoft Store package generation evidence backup',
      );
      file.previousIdentity = evidenceFileIdentity(metadata, backupSnapshot);

      if (!microsoftStoreEvidenceFileMatchesIdentity(file.finalFile, file.previousIdentity)) {
        throw new Error(
          `Microsoft Store package generation evidence changed while it was backed up: ${file.finalFile}`,
        );
      }
    }

    for (const file of files) {
      if (file.previousIdentity === undefined) {
        linkSync(file.temporaryFile, file.finalFile);
        unlinkSync(file.temporaryFile);
      } else {
        if (!microsoftStoreEvidenceFileMatchesIdentity(file.finalFile, file.previousIdentity)) {
          throw new Error(
            `Microsoft Store package generation evidence changed before publication: ${file.finalFile}`,
          );
        }

        renameSync(file.temporaryFile, file.finalFile);
      }

      file.temporaryExists = false;
      file.publishedIdentity = evidenceFileIdentity(
        lstatSync(file.finalFile),
        file.contentsSnapshot,
      );
    }

    completed = true;
  } catch (error) {
    throw new Error(
      `Failed to write Microsoft Store package generation evidence: ${formatError(error)}`,
      { cause: error },
    );
  } finally {
    if (!completed) {
      for (const file of [...files].reverse()) {
        rollbackEvidenceFilePublication(file);
      }
    }

    for (const file of files) {
      unlinkIfPresent(file.temporaryFile, file.temporaryExists);
      unlinkIfPresent(file.backupFile, file.backupExists);
      removeMicrosoftStoreEvidenceLockIfOwned(file.lockFile, file.lockIdentity, file.lockToken);
    }
  }
}

function createEvidenceFilePublication(
  finalFile: string,
  contents: string,
  transactionId: string,
): MicrosoftStoreEvidenceFilePublication {
  const prefix = `.${path.basename(finalFile)}.${transactionId}`;
  const contentsBytes = Buffer.from(contents);

  return {
    finalFile,
    temporaryFile: path.join(path.dirname(finalFile), `${prefix}.tmp`),
    backupFile: path.join(path.dirname(finalFile), `${prefix}.bak`),
    lockFile: path.join(
      path.dirname(finalFile),
      `.${path.basename(finalFile)}.mpgd-package-generation.lock`,
    ),
    contents,
    contentsSnapshot: {
      sizeBytes: contentsBytes.length,
      sha256: hashMicrosoftStoreBytes(contentsBytes),
    },
    temporaryExists: false,
    backupExists: false,
  };
}

function acquireEvidenceFileLock(
  file: MicrosoftStoreEvidenceFilePublication,
  transactionId: string,
): void {
  let descriptor: number;

  try {
    descriptor = openSync(file.lockFile, 'wx', 0o600);
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error(
        `Microsoft Store package generation evidence is already being written: ${file.finalFile}`,
      );
    }

    throw error;
  }

  file.lockToken = transactionId;
  let initialized = false;

  try {
    file.lockIdentity = fileNodeIdentity(fstatSync(descriptor));
    writeFileSync(descriptor, `${transactionId}\n`);
    initialized = true;
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      if (!initialized && unlinkImmediately(file.lockFile)) {
        delete file.lockIdentity;
        delete file.lockToken;
      }
    }
  }
}

function rollbackEvidenceFilePublication(file: MicrosoftStoreEvidenceFilePublication): void {
  if (file.publishedIdentity === undefined) {
    return;
  }

  let matchesIdentity = false;

  try {
    matchesIdentity = microsoftStoreEvidenceFileMatchesIdentity(
      file.finalFile,
      file.publishedIdentity,
    );
  } catch {
    // Preserve the backup for manual recovery when rollback inspection fails.
    file.backupExists = false;
    return;
  }

  if (!matchesIdentity) {
    // A concurrent writer replaced the final file; preserve the backup for manual recovery.
    file.backupExists = false;
    return;
  }

  if (file.backupExists) {
    try {
      renameSync(file.backupFile, file.finalFile);
      file.backupExists = false;
    } catch {
      // Preserve the backup for manual recovery when an atomic rollback cannot complete.
      file.backupExists = false;
    }
    return;
  }

  try {
    unlinkSync(file.finalFile);
  } catch {
    // Do not mask the original evidence publication failure.
  }
}

export function microsoftStoreEvidenceFileMatchesIdentity(
  file: string,
  expected: MicrosoftStoreEvidenceFileIdentity,
): boolean {
  const metadata = lstatIfExists(file);

  if (metadata === undefined || !metadata.isFile() || metadata.dev !== expected.dev) {
    return false;
  }

  if (expected.ino !== 0) {
    return metadata.ino === expected.ino
      && metadata.size === expected.sizeBytes
      && metadata.mtimeMs === expected.mtimeMs
      && metadata.ctimeMs === expected.ctimeMs;
  }

  const actual = hashMicrosoftStoreFileSnapshot(
    file,
    'Microsoft Store package generation evidence ownership check',
  );
  return actual.sizeBytes === expected.sizeBytes
    && actual.sha256 === expected.sha256;
}

function fileNodeIdentity(metadata: Stats): MicrosoftStoreFileNodeIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function metadataMatchesNodeIdentity(
  metadata: Stats,
  expected: MicrosoftStoreFileNodeIdentity,
): boolean {
  return expected.ino !== 0
    && metadata.dev === expected.dev
    && metadata.ino === expected.ino;
}

function evidenceFileIdentity(
  metadata: Stats,
  snapshot: MicrosoftStoreFileSnapshot,
): MicrosoftStoreEvidenceFileIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    ...snapshot,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

function lstatIfExists(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }

    throw error;
  }
}

function unlinkIfPresent(file: string, expectedToExist: boolean): void {
  if (!expectedToExist || !existsSync(file)) {
    return;
  }

  try {
    unlinkSync(file);
  } catch {
    // Temporary cleanup must not invalidate otherwise consistent evidence outputs.
  }
}

function unlinkImmediately(file: string): boolean {
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function removeMicrosoftStoreEvidenceLockIfOwned(
  file: string,
  expected: MicrosoftStoreFileNodeIdentity | undefined,
  token: string | undefined,
): void {
  if (expected === undefined || token === undefined) {
    return;
  }

  try {
    const metadata = lstatIfExists(file);

    if (
      metadata !== undefined
      && metadata.isFile()
      && (
        metadataMatchesNodeIdentity(metadata, expected)
        || (
          expected.ino === 0
          && microsoftStoreEvidenceLockMatchesToken(file, token)
        )
      )
    ) {
      unlinkSync(file);
    }
  } catch {
    // Do not remove a lock whose ownership can no longer be proven.
  }
}

function microsoftStoreEvidenceLockMatchesToken(file: string, token: string): boolean {
  const expected = Buffer.from(`${token}\n`);
  const descriptor = openSync(file, 'r');

  try {
    const metadata = fstatSync(descriptor);

    if (!metadata.isFile() || metadata.size !== expected.length) {
      return false;
    }

    const contents = Buffer.allocUnsafe(expected.length);
    let offset = 0;

    while (offset < contents.length) {
      const bytesRead = readSync(descriptor, contents, offset, contents.length - offset, offset);

      if (bytesRead === 0) {
        return false;
      }

      offset += bytesRead;
    }

    return contents.equals(expected);
  } finally {
    closeSync(descriptor);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export function renderMicrosoftStorePackageGenerationMarkdown(
  evidence: MicrosoftStorePackageGenerationEvidence,
): string {
  return `# Microsoft Store Package Generation

- PWA URL: ${escapeMarkdownInline(evidence.pwaUrl)}
- Manifest URL: ${escapeMarkdownInline(evidence.manifest.url)}
- Manifest SHA-256: \`${evidence.manifest.sha256}\`
- Manifest pinned in generator request: yes
- Manifest icons verified before and after generator: ${evidence.manifest.icons.count}
- Modern version: \`${evidence.modernVersion}\`
- Classic version: \`${evidence.classicVersion}\`
- Package ID: ${escapeMarkdownInline(evidence.productIdentity.packageId)}
- Publisher ID: ${escapeMarkdownInline(evidence.productIdentity.publisherId)}
- Generator endpoint: ${escapeMarkdownInline(evidence.generator.endpoint)}
- Generator contract: ${evidence.generator.contract}
- Generator request SHA-256: \`${evidence.generator.requestSha256}\`
- Package inspection: required before submission

| Archive | Bytes | SHA-256 |
| --- | ---: | --- |
| ${escapeMarkdownTable(evidence.archive.file)} | ${evidence.archive.sizeBytes} | \`${evidence.archive.sha256}\` |
`;
}
