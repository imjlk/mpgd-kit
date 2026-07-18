import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import { formatError } from './evidence-io.js';
import {
  microsoftStorePackageGeneratorEndpoint,
  type CreateMicrosoftStorePackageGenerationRuntimeInput,
  type MicrosoftStoreFileSnapshot,
  type MicrosoftStoreManifestIconInput,
  type MicrosoftStorePackageGenerationRuntime,
} from './microsoft-store-package-generation-contract.js';
import {
  hashMicrosoftStoreBytes,
  hashMicrosoftStoreFileSnapshot,
} from './microsoft-store-package-generation-integrity.js';
import { assertMicrosoftStorePackageZip } from './microsoft-store-package-generation-zip.js';

const maximumManifestBytes = 1024 * 1024;
const maximumManifestIconBytes = 2 * 1024 * 1024;
const maximumArchiveBytes = 512 * 1024 * 1024;
const manifestRequestTimeoutMs = 30_000;
const manifestIconRequestTimeoutMs = 30_000;
const packageRequestTimeoutMs = 10 * 60 * 1_000;

interface WithMicrosoftStorePackageArchiveInput {
  readonly runtime: MicrosoftStorePackageGenerationRuntime;
  readonly manifestUrl: string;
  readonly manifestSha256: string;
  readonly manifestIcons: readonly MicrosoftStoreManifestIconInput[];
  readonly requestBody: string;
  readonly outputFile: string;
  readonly assertInputsUnchanged: () => void;
}

interface MicrosoftStorePublishedFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export function createMicrosoftStorePackageGenerationRuntime(
  input: CreateMicrosoftStorePackageGenerationRuntimeInput = {},
): MicrosoftStorePackageGenerationRuntime {
  const fetcher = input.fetch ?? globalThis.fetch;

  if (typeof fetcher !== 'function') {
    throw new Error('Microsoft Store package generation requires a Fetch API implementation.');
  }

  return { fetch: fetcher };
}

export async function withMicrosoftStorePackageArchive<Result>(
  input: WithMicrosoftStorePackageArchiveInput,
  consume: (archive: MicrosoftStoreFileSnapshot) => Result | Promise<Result>,
): Promise<Result> {
  await assertRemoteManifestMatches(
    input.manifestUrl,
    input.manifestSha256,
    input.runtime,
    'before package generation',
  );
  await assertRemoteManifestIconsMatch(
    input.manifestIcons,
    input.runtime,
    'before package generation',
  );

  const temporaryFile = path.join(
    path.dirname(input.outputFile),
    `.${path.basename(input.outputFile)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryFileExists = false;
  let publishedOutputIdentity: MicrosoftStorePublishedFileIdentity | undefined;
  let completed = false;

  try {
    const response = await fetchResponse(
      input.runtime,
      microsoftStorePackageGeneratorEndpoint,
      {
        method: 'POST',
        body: input.requestBody,
        headers: {
          accept: 'application/zip',
          'accept-encoding': 'identity',
          'content-type': 'application/json',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(packageRequestTimeoutMs),
      },
      'PWABuilder package generator',
    );
    await assertSuccessfulResponse(response, 'PWABuilder package generator');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();

    if (contentType !== 'application/zip') {
      await cancelResponse(response);
      throw new Error(
        `PWABuilder package generator must return application/zip, received ${contentType ?? 'missing content type'}.`,
      );
    }

    const declaredLength = await readContentLengthSafely(response, 'PWABuilder package generator');

    if (declaredLength !== undefined && declaredLength > maximumArchiveBytes) {
      await cancelResponse(response);
      throw new Error('PWABuilder package archive exceeds the 512 MiB size limit.');
    }

    temporaryFileExists = true;
    const archive = await writeBoundedResponseToFile(
      response,
      temporaryFile,
      maximumArchiveBytes,
      'PWABuilder package archive',
    );

    if (declaredLength !== undefined && archive.sizeBytes !== declaredLength) {
      throw new Error(
        `PWABuilder package archive length mismatch: expected ${declaredLength}, received ${archive.sizeBytes}.`,
      );
    }

    assertMicrosoftStorePackageZip(temporaryFile, archive.sizeBytes);
    input.assertInputsUnchanged();
    await assertRemoteManifestMatches(
      input.manifestUrl,
      input.manifestSha256,
      input.runtime,
      'after package generation',
    );
    await assertRemoteManifestIconsMatch(
      input.manifestIcons,
      input.runtime,
      'after package generation',
    );
    input.assertInputsUnchanged();

    const temporaryMetadata = lstatSync(temporaryFile);

    try {
      linkSync(temporaryFile, input.outputFile);
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        throw new Error(
          `Microsoft Store package ZIP appeared during generation: ${input.outputFile}`,
        );
      }

      throw new Error(
        `Failed to publish Microsoft Store package ZIP: ${input.outputFile} (${formatError(error)})`,
      );
    }

    publishedOutputIdentity = {
      dev: temporaryMetadata.dev,
      ino: temporaryMetadata.ino,
    };
    unlinkSync(temporaryFile);
    temporaryFileExists = false;
    const outputSnapshot = hashMicrosoftStoreFileSnapshot(
      input.outputFile,
      'Microsoft Store package ZIP',
    );

    if (
      outputSnapshot.sizeBytes !== archive.sizeBytes
      || outputSnapshot.sha256 !== archive.sha256
    ) {
      throw new Error('Microsoft Store package ZIP changed during atomic publication.');
    }

    const result = await consume(outputSnapshot);
    completed = true;
    return result;
  } finally {
    if (temporaryFileExists && existsSync(temporaryFile)) {
      try {
        unlinkSync(temporaryFile);
      } catch {
        // Best-effort cleanup must not mask the package generation failure.
      }
    }

    if (publishedOutputIdentity !== undefined && !completed) {
      try {
        unlinkIfIdentityMatches(input.outputFile, publishedOutputIdentity);
      } catch {
        // Best-effort cleanup must not mask the package generation failure.
      }
    }
  }
}

async function assertRemoteManifestIconsMatch(
  icons: readonly MicrosoftStoreManifestIconInput[],
  runtime: MicrosoftStorePackageGenerationRuntime,
  phase: string,
): Promise<void> {
  for (const [index, icon] of icons.entries()) {
    const label = `deployed Microsoft Store manifest icon[${index}] ${phase}`;
    const response = await fetchResponse(
      runtime,
      icon.url,
      {
        method: 'GET',
        headers: { accept: 'image/png', 'accept-encoding': 'identity' },
        redirect: 'manual',
        signal: AbortSignal.timeout(manifestIconRequestTimeoutMs),
      },
      label,
    );
    await assertSuccessfulResponse(response, label);
    const bytes = await readBoundedResponse(response, maximumManifestIconBytes, label);
    const actualSha256 = hashMicrosoftStoreBytes(bytes);

    if (actualSha256 !== icon.snapshot.sha256) {
      throw new Error(
        `Deployed Microsoft Store manifest icon[${index}] SHA-256 must match submission evidence ${phase}: expected ${icon.snapshot.sha256}, received ${actualSha256}.`,
      );
    }
  }
}

async function assertRemoteManifestMatches(
  manifestUrl: string,
  expectedSha256: string,
  runtime: MicrosoftStorePackageGenerationRuntime,
  phase: string,
): Promise<void> {
  const response = await fetchResponse(
    runtime,
    manifestUrl,
    {
      method: 'GET',
      headers: {
        accept: 'application/manifest+json, application/json',
        'accept-encoding': 'identity',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(manifestRequestTimeoutMs),
    },
    `deployed Microsoft Store manifest ${phase}`,
  );
  await assertSuccessfulResponse(response, `deployed Microsoft Store manifest ${phase}`);
  const bytes = await readBoundedResponse(
    response,
    maximumManifestBytes,
    `deployed Microsoft Store manifest ${phase}`,
  );
  const actualSha256 = hashMicrosoftStoreBytes(bytes);

  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Deployed Microsoft Store manifest SHA-256 must match submission evidence ${phase}: expected ${expectedSha256}, received ${actualSha256}.`,
    );
  }
}

async function fetchResponse(
  runtime: MicrosoftStorePackageGenerationRuntime,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await runtime.fetch(url, init);
  } catch (error) {
    throw new Error(`${label} request failed: ${formatError(error)}`);
  }
}

async function assertSuccessfulResponse(response: Response, label: string): Promise<void> {
  if (response.status < 200 || response.status >= 300) {
    await cancelResponse(response);
    throw new Error(`${label} must return a 2xx response, received ${response.status}.`);
  }
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  const declaredLength = await readContentLengthSafely(response, label);

  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    await cancelResponse(response);
    throw new Error(`${label} exceeds the ${maximumBytes}-byte size limit.`);
  }

  if (response.body === null) {
    throw new Error(`${label} response body is missing.`);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let sizeBytes = 0;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      const chunk = Buffer.from(result.value);
      sizeBytes += chunk.length;

      if (sizeBytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds the ${maximumBytes}-byte size limit.`);
      }

      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== undefined && declaredLength !== sizeBytes) {
    throw new Error(`${label} length mismatch: expected ${declaredLength}, received ${sizeBytes}.`);
  }

  return Buffer.concat(chunks, sizeBytes);
}

async function writeBoundedResponseToFile(
  response: Response,
  file: string,
  maximumBytes: number,
  label: string,
): Promise<MicrosoftStoreFileSnapshot> {
  if (response.body === null) {
    throw new Error(`${label} response body is missing.`);
  }

  const descriptor = openSync(file, 'wx', 0o600);
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let sizeBytes = 0;
  let completed = false;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      const chunk = Buffer.from(result.value);
      sizeBytes += chunk.length;

      if (sizeBytes > maximumBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds the ${maximumBytes}-byte size limit.`);
      }

      hash.update(chunk);
      writeAll(descriptor, chunk);
    }

    completed = true;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // A bounded response may already be cancelled after crossing its limit.
      }
    }

    reader.releaseLock();
    closeSync(descriptor);

    if (!completed && existsSync(file)) {
      unlinkSync(file);
    }
  }

  return { sizeBytes, sha256: hash.digest('hex') };
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;

  while (offset < bytes.length) {
    offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
  }
}

function readContentLength(response: Response, label: string): number | undefined {
  const contentEncoding = response.headers.get('content-encoding');

  if (contentEncoding !== null && contentEncoding.trim().toLowerCase() !== 'identity') {
    return undefined;
  }

  const value = response.headers.get('content-length');

  if (value === null) {
    return undefined;
  }

  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} returned an invalid Content-Length header.`);
  }

  const length = Number(value);

  if (!Number.isSafeInteger(length)) {
    throw new Error(`${label} returned an unsupported Content-Length header.`);
  }

  return length;
}

function unlinkIfIdentityMatches(
  file: string,
  expected: MicrosoftStorePublishedFileIdentity,
): void {
  let metadata: ReturnType<typeof lstatSync>;

  try {
    metadata = lstatSync(file);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }

    throw error;
  }

  if (metadata.dev === expected.dev && metadata.ino === expected.ino) {
    unlinkSync(file);
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function readContentLengthSafely(
  response: Response,
  label: string,
): Promise<number | undefined> {
  try {
    return readContentLength(response, label);
  } catch (error) {
    await cancelResponse(response);
    throw error;
  }
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A response body may already be closed after an HTTP or validation failure.
  }
}
