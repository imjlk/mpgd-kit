import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
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
import { hashMicrosoftStoreBytes } from './microsoft-store-package-generation-integrity.js';

export {
  microsoftStorePackageGenerationSchemaVersion,
  microsoftStorePackageGeneratorEndpoint,
  microsoftStorePackageGeneratorSourceRevision,
  type CreateMicrosoftStorePackageGenerationRuntimeInput,
  type MicrosoftStorePackageGenerationEvidence,
  type MicrosoftStorePackageGenerationRuntime,
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
  readonly contents: string;
  temporaryExists: boolean;
  backupExists: boolean;
  publishedIdentity?: {
    readonly dev: number;
    readonly ino: number;
  };
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
      writeFileSync(file.temporaryFile, file.contents, { flag: 'wx', mode: 0o600 });
      file.temporaryExists = true;
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

      linkSync(file.finalFile, file.backupFile);
      file.backupExists = true;
    }

    for (const file of files) {
      const metadata = lstatSync(file.temporaryFile);
      renameSync(file.temporaryFile, file.finalFile);
      file.temporaryExists = false;
      file.publishedIdentity = { dev: metadata.dev, ino: metadata.ino };
    }

    completed = true;
  } catch (error) {
    throw new Error(
      `Failed to write Microsoft Store package generation evidence: ${formatError(error)}`,
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
    }
  }
}

function createEvidenceFilePublication(
  finalFile: string,
  contents: string,
  transactionId: string,
): MicrosoftStoreEvidenceFilePublication {
  const prefix = `.${path.basename(finalFile)}.${transactionId}`;

  return {
    finalFile,
    temporaryFile: path.join(path.dirname(finalFile), `${prefix}.tmp`),
    backupFile: path.join(path.dirname(finalFile), `${prefix}.bak`),
    contents,
    temporaryExists: false,
    backupExists: false,
  };
}

function rollbackEvidenceFilePublication(file: MicrosoftStoreEvidenceFilePublication): void {
  if (file.publishedIdentity === undefined) {
    return;
  }

  if (!fileMatchesIdentity(file.finalFile, file.publishedIdentity)) {
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

function fileMatchesIdentity(
  file: string,
  expected: { readonly dev: number; readonly ino: number },
): boolean {
  const metadata = lstatIfExists(file);
  return metadata !== undefined && metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function lstatIfExists(file: string): ReturnType<typeof lstatSync> | undefined {
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
