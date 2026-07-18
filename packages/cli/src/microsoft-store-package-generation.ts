import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  escapeMarkdownInline,
  escapeMarkdownTable,
  relativeOrAbsolute,
  writeEvidenceReportFiles,
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
      writeEvidenceReportFiles({
        jsonFile: prepared.jsonFile,
        markdownFile: prepared.markdownFile,
        report: evidence,
        markdown: renderMicrosoftStorePackageGenerationMarkdown(evidence),
      });

      return evidence;
    },
  );
}

export function renderMicrosoftStorePackageGenerationMarkdown(
  evidence: MicrosoftStorePackageGenerationEvidence,
): string {
  return `# Microsoft Store Package Generation

- PWA URL: ${escapeMarkdownInline(evidence.pwaUrl)}
- Manifest URL: ${escapeMarkdownInline(evidence.manifest.url)}
- Manifest SHA-256: \`${evidence.manifest.sha256}\`
- Manifest pinned in generator request: yes
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
