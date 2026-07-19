import { createHash, randomUUID } from 'node:crypto';
import { lookup as lookupDns } from 'node:dns/promises';
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { BlockList, type LookupFunction } from 'node:net';
import path from 'node:path';

import {
  Agent,
  fetch as undiciFetch,
  Request as UndiciRequest,
  type Dispatcher,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import { formatError } from './evidence-io.js';
import {
  microsoftStorePackageGeneratorEndpoint,
  type CreateMicrosoftStorePackageGenerationRuntimeInput,
  type MicrosoftStoreAddressResolver,
  type MicrosoftStoreFileSnapshot,
  type MicrosoftStoreManifestIconInput,
  type MicrosoftStorePackageGenerationRuntime,
  type MicrosoftStoreResolvedAddress,
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
const blockedIpv4Addresses = createBlockedIpv4Addresses();
const blockedIpv6Addresses = createBlockedIpv6Addresses();
const allowedIpv6GlobalUnicastAddresses = createAllowedIpv6GlobalUnicastAddresses();

interface WithMicrosoftStorePackageArchiveInput {
  readonly runtime: MicrosoftStorePackageGenerationRuntime;
  readonly manifestUrl: string;
  readonly manifestSha256: string;
  readonly manifestIcons: readonly MicrosoftStoreManifestIconInput[];
  readonly requestBody: string;
  readonly outputFile: string;
  readonly assertInputsUnchanged: () => void;
  readonly afterPlacement?: (file: string) => void;
}

interface MicrosoftStorePublishedFileIdentity extends MicrosoftStoreFileSnapshot {
  readonly dev: number;
  readonly ino: number;
}

export function createMicrosoftStorePackageGenerationRuntime(
  input: CreateMicrosoftStorePackageGenerationRuntimeInput = {},
): MicrosoftStorePackageGenerationRuntime {
  const fetcher = input.fetch ?? createPublicOnlyFetch(input.resolveAddresses);

  if (typeof fetcher !== 'function') {
    throw new Error('Microsoft Store package generation requires a Fetch API implementation.');
  }

  return { fetch: fetcher };
}

function createPublicOnlyFetch(resolveAddresses?: MicrosoftStoreAddressResolver): typeof fetch {
  const dispatcher = new Agent({
    connect: {
      lookup: createPublicOnlyLookup(
        (hostname) => resolveMicrosoftStorePublicAddresses(hostname, resolveAddresses),
      ),
    },
  });

  return createMicrosoftStoreDispatcherFetch(dispatcher);
}

export function createMicrosoftStoreDispatcherFetch(dispatcher: Dispatcher): typeof fetch {
  return (async (input, init = {}) => {
    const response = await undiciFetch(toUndiciRequestInfo(input), {
      ...(init as UndiciRequestInit),
      dispatcher,
    });

    // Undici implements Node's global Fetch API, but publishes a distinct Response type.
    return response as unknown as Response;
  }) as typeof fetch;
}

function toUndiciRequestInfo(input: string | URL | Request): UndiciRequestInfo {
  if (typeof input === 'string' || input instanceof URL) {
    return input;
  }

  return new UndiciRequest(input.url, {
    cache: input.cache,
    credentials: input.credentials,
    headers: Object.fromEntries(input.headers),
    integrity: input.integrity,
    keepalive: input.keepalive,
    method: input.method,
    mode: input.mode,
    redirect: input.redirect,
    referrer: input.referrer,
    referrerPolicy: input.referrerPolicy,
    signal: input.signal,
    ...(input.body === null
      ? {}
      : {
          body: input.body as unknown as AsyncIterable<Uint8Array>,
          duplex: 'half' as const,
        }),
  });
}

function createPublicOnlyLookup(
  resolveAddresses: MicrosoftStoreAddressResolver,
): LookupFunction {
  return (hostname, options, callback) => {
    void resolveAddresses(hostname).then(
      (addresses) => {
        if (options.all === true) {
          callback(null, [...addresses]);
          return;
        }

        let family = options.family;

        if (family === 'IPv4') {
          family = 4;
        } else if (family === 'IPv6') {
          family = 6;
        }
        const selected = addresses.find(
          (address) => family === undefined || family === 0 || address.family === family,
        );

        if (selected === undefined) {
          callback(new Error(`No public address matched the requested family for ${hostname}.`), []);
          return;
        }

        callback(null, selected.address, selected.family);
      },
      (error: unknown) => {
        callback(
          error instanceof Error
            ? error
            : new Error(`Failed to resolve a public address for ${hostname}.`),
          [],
        );
      },
    );
  };
}

export async function resolveMicrosoftStorePublicAddresses(
  hostname: string,
  resolver: MicrosoftStoreAddressResolver = async (value) => lookupDns(value, {
    all: true,
    order: 'verbatim',
  }),
): Promise<readonly MicrosoftStoreResolvedAddress[]> {
  const addresses = await resolver(hostname);

  if (addresses.length === 0) {
    throw new Error(`Microsoft Store package generation host did not resolve: ${hostname}.`);
  }

  for (const address of addresses) {
    const family = address.family === 4 ? 'ipv4' : address.family === 6 ? 'ipv6' : undefined;

    if (
      family === undefined
      || (family === 'ipv4' && blockedIpv4Addresses.check(address.address, family))
      || (
        family === 'ipv6'
        && (
          !allowedIpv6GlobalUnicastAddresses.check(address.address, family)
          || blockedIpv6Addresses.check(address.address, family)
        )
      )
    ) {
      throw new Error(
        `Microsoft Store package generation host must resolve only to public addresses: ${hostname} resolved to ${address.address}.`,
      );
    }
  }

  return addresses;
}

function createBlockedIpv4Addresses(): BlockList {
  const blockList = new BlockList();

  // IANA special-purpose ranges, including private, loopback, link-local,
  // documentation, benchmarking, multicast, and reserved space (RFC 6890).
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv4');
  }

  return blockList;
}

function createBlockedIpv6Addresses(): BlockList {
  const blockList = new BlockList();

  // IANA special-purpose ranges, including mapped/translated IPv4, loopback,
  // documentation, unique-local, link-local, multicast, and reserved space.
  for (const [network, prefix] of [
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv6');
  }

  return blockList;
}

function createAllowedIpv6GlobalUnicastAddresses(): BlockList {
  const blockList = new BlockList();

  // IANA currently assigns public IPv6 global unicast space from 2000::/3.
  // Special-purpose subnets inside it remain denied by blockedIpv6Addresses.
  blockList.addSubnet('2000::', 3, 'ipv6');
  return blockList;
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
      sizeBytes: archive.sizeBytes,
      sha256: archive.sha256,
    };
    input.afterPlacement?.(input.outputFile);
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
        removeMicrosoftStorePackageZipIfOwned(input.outputFile, publishedOutputIdentity);
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

export function removeMicrosoftStorePackageZipIfOwned(
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

  if (
    expected.ino !== 0
    && metadata.dev === expected.dev
    && metadata.ino === expected.ino
  ) {
    unlinkSync(file);
    return;
  }

  if (expected.ino !== 0 || !metadata.isFile() || metadata.dev !== expected.dev) {
    return;
  }

  const actual = hashMicrosoftStoreFileSnapshot(
    file,
    'published Microsoft Store package ZIP cleanup',
  );

  if (
    actual.sizeBytes === expected.sizeBytes
    && actual.sha256 === expected.sha256
  ) {
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
