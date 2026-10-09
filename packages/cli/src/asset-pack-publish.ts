import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  parsePhaserPackEntryPath,
  validatePhaserPackDeliveryManifest,
} from '@mpgd/phaser-assets/pack-format';
import {
  assertAssetPackDeliveryPolicy,
  resolveAssetPackLocations,
} from '@mpgd/target-config/asset-packs';
import { assetPackTargetManifestName, assetPackTargetPolicyName } from './asset-pack-target.js';

export interface AssetPackPublicationOptions {
  /** Fresh stage-target output with packaged/ and remote/ children. */
  readonly deployment: string;
  readonly endpoint: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly region?: string;
  readonly dryRun?: boolean;
  /** Explicit local protocol fixture opt-in; HTTPS remains the production default. */
  readonly allowHttpLoopback?: boolean;
  readonly accessKeyEnv?: string;
  readonly secretKeyEnv?: string;
  readonly sessionTokenEnv?: string;
  readonly maxObjectBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxObjects?: number;
  readonly requestTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AssetPackPublicationReport {
  readonly dryRun: boolean;
  readonly endpoint: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly manifestSha256: string;
  readonly plannedBytes: number;
  /** Object body bytes only, not HTTP headers, retries or physical wire bytes. */
  readonly uploadedBytes: number;
  readonly objects: readonly {
    readonly key: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly action: 'planned' | 'uploaded' | 'reused';
  }[];
}

export class AssetPackPublicationError extends Error {
  constructor(
    readonly code: 'config' | 'source' | 'integrity' | 'limit' | 'collision' | 's3' | 'timeout' | 'cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'AssetPackPublicationError';
  }
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const immutableCacheControl = 'public, max-age=31536000, immutable';
const fail = (code: AssetPackPublicationError['code'], message: string): never => {
  throw new AssetPackPublicationError(code, message);
};
const positive = (value: number, maximum: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail('config', `Invalid bounded publication option: ${field}`);
  }
  return value;
};

async function readBounded(path: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('source', 'Publication source must be a regular non-symlink file');
  }
  if (stat.size > maximum) {
    fail('limit', 'Publication source exceeds its byte limit');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const stream = handle.createReadStream({
    signal,
    highWaterMark: 64 * 1024,
  });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > maximum) {
        fail('limit', 'Publication source grew beyond its byte limit');
      }
      chunks.push(bytes);
    }
  } finally {
    stream.destroy();
    await handle.close();
  }
  return Buffer.concat(chunks, size);
}

async function safeObjectPath(root: string, path: string): Promise<string> {
  parsePhaserPackEntryPath(path);
  let current = root;
  for (const component of path.split('/')) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      fail('source', 'Publication object path traverses a symbolic link');
    }
  }
  return current;
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) {
    return undefined;
  }
  const status = (error.$metadata as { httpStatusCode?: unknown } | undefined)?.httpStatusCode;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

/** The deployment tool owns all storage credentials; no ambient AWS profile or
 * credentials provider chain is consulted, and SDK errors never reach logs. */
export async function publishAssetPacks(options: AssetPackPublicationOptions): Promise<AssetPackPublicationReport> {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    return fail('config', 'Publication endpoint must be an HTTPS root URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(options.allowHttpLoopback === true && endpoint.protocol === 'http:' && loopback))
    || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    fail(
      'config',
      'Publication endpoint requires HTTPS without credentials, path, query or fragment (explicit HTTP loopback opt-in available)',
    );
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) || options.bucket.includes('..')
    || /^\d+\.\d+\.\d+\.\d+$/.test(options.bucket)) {
    fail('config', 'Publication requires a regular S3 bucket name, not an ARN');
  }
  let prefix: string;
  try {
    prefix = parsePhaserPackEntryPath(options.prefix.replace(/\/$/, ''));
  } catch {
    return fail('config', 'Publication prefix must be a non-empty normalized relative object path');
  }
  const region = options.region ?? 'us-east-1';
  if (!/^[a-z0-9-]{1,64}$/.test(region)) {
    fail('config', 'Invalid publication region');
  }
  const maxObjectBytes = positive(
    options.maxObjectBytes ?? 64 * 1024 ** 2,
    512 * 1024 ** 2,
    'maxObjectBytes',
  );
  const maxTotalBytes = positive(
    options.maxTotalBytes ?? 1024 ** 3,
    Number.MAX_SAFE_INTEGER,
    'maxTotalBytes',
  );
  const maxObjects = positive(options.maxObjects ?? 10_000, 100_000, 'maxObjects');
  const requestTimeoutMs = positive(
    options.requestTimeoutMs ?? 10_000,
    2 ** 31 - 2,
    'requestTimeoutMs',
  );
  const timeoutMs = positive(options.timeoutMs ?? 120_000, 2 ** 31 - 2, 'timeoutMs');
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  let client: S3Client | undefined;
  try {
    const deployment = await realpath(resolve(options.deployment));
    const metadataRoot = await safeObjectPath(deployment, 'packaged');
    const remoteRoot = await safeObjectPath(deployment, 'remote');
    const manifestBytes = await readBounded(
      join(metadataRoot, assetPackTargetManifestName),
      32 * 1024 ** 2,
      signal,
    );
    const manifest = validatePhaserPackDeliveryManifest(JSON.parse(manifestBytes.toString('utf8')));
    const policy = JSON.parse(
      (await readBounded(join(metadataRoot, assetPackTargetPolicyName), 1024 ** 2, signal)).toString(
        'utf8',
      ),
    ) as unknown;
    assertAssetPackDeliveryPolicy(policy);
    const locations = resolveAssetPackLocations(policy, manifest.packs);
    const planned = new Map<string, { key: string; path?: string; bytes: number; sha256: string; mediaType: string }>();
    for (const pack of manifest.packs) {
      if (locations[pack.packId] !== 'remote') {
        continue;
      }
      const files = pack.delivery === 'zip'
        ? [{ ...pack.archive!, mediaType: 'application/zip' }]
        : pack.assets.flatMap((asset) => asset.files);
      for (const file of files) {
        const key = `${prefix}/${file.path}`;
        planned.set(key, {
          key,
          path: file.path,
          bytes: file.bytes,
          sha256: file.sha256,
          mediaType: file.mediaType,
        });
      }
    }
    const manifestSha256 = sha(manifestBytes);
    const snapshotKey = `${prefix}/manifests/${manifestSha256}.json`;
    const objects = [...planned.values()].sort((a, b) => a.key.localeCompare(b.key));
    // The immutable snapshot is the final publication marker. There is no
    // mutable latest pointer and no claim of a cross-object transaction.
    objects.push({
      key: snapshotKey,
      bytes: manifestBytes.length,
      sha256: manifestSha256,
      mediaType: 'application/json',
    });
    const plannedBytes = objects.reduce((sum, object) => sum + object.bytes, 0);
    if (objects.length > maxObjects || !Number.isSafeInteger(plannedBytes) || plannedBytes > maxTotalBytes
      || objects.some((object) => object.bytes > maxObjectBytes)) {
      fail('limit', 'Publication plan exceeds its object or byte limits');
    }
    const bytesFor = async (object: typeof objects[number]): Promise<Buffer> => {
      signal.throwIfAborted();
      const bytes = object.path === undefined
        ? manifestBytes
        : await readBounded(await safeObjectPath(remoteRoot, object.path), object.bytes, signal);
      if (bytes.length !== object.bytes || sha(bytes) !== object.sha256) {
        fail('integrity', 'Publication object does not match its pinned manifest bytes and digest');
      }
      return bytes;
    };
    // Validate every source before the first external write, then revalidate
    // each object immediately before sending it. Keep only one body resident.
    for (const object of objects) {
      await bytesFor(object);
    }
    const results: AssetPackPublicationReport['objects'][number][] = [];
    if (options.dryRun === true) {
      for (const object of objects) {
        results.push({
          key: object.key,
          bytes: object.bytes,
          sha256: object.sha256,
          action: 'planned',
        });
      }
    } else {
      const value = (name: string, required: boolean): string | undefined => {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
          fail('config', 'Credential options must name environment variables');
        }
        const result = process.env[name];
        if ((required && !result) || (result !== undefined && (result.length > 16_384 || /[\s\x00-\x1f\x7f]/.test(result)))) {
          fail('config', 'Publication credential environment is missing or invalid');
        }
        return result;
      };
      const accessKeyId = value(options.accessKeyEnv ?? 'MPGD_ASSETS_S3_ACCESS_KEY_ID', true)!;
      const secretAccessKey = value(
        options.secretKeyEnv ?? 'MPGD_ASSETS_S3_SECRET_ACCESS_KEY',
        true,
      )!;
      const sessionToken = value(options.sessionTokenEnv ?? 'MPGD_ASSETS_S3_SESSION_TOKEN', false);
      client = new S3Client({
        endpoint: endpoint.href, region, forcePathStyle: true, followRegionRedirects: false, maxAttempts: 1,
        requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
        credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
        requestHandler: new NodeHttpHandler({ connectionTimeout: requestTimeoutMs, socketTimeout: requestTimeoutMs, requestTimeout: requestTimeoutMs }),
      });
      const request = async <T>(action: (attemptSignal: AbortSignal) => Promise<T>): Promise<T> => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]);
          try {
            return await action(attemptSignal);
          } catch (error) {
            if (attemptSignal.aborted) {
              fail(
                options.signal?.aborted ? 'cancelled' : 'timeout',
                'Asset publication request exceeded its deadline or was cancelled',
              );
            }
            if (attempt === 0 && [409, 429, 500, 502, 503, 504].includes(httpStatus(error) ?? 0)) {
              await delay(100, undefined, { signal });
              continue;
            }
            throw error;
          }
        }
        return fail('s3', 'Asset publication request exhausted its attempt limit');
      };
      const head = async (key: string): Promise<HeadObjectCommandOutput | undefined> => {
        try {
          return await request((attemptSignal) =>
            client!.send(
              new HeadObjectCommand({ Bucket: options.bucket, Key: key, ChecksumMode: 'ENABLED' }),
              { abortSignal: attemptSignal },
            ),
          );
        } catch (error) {
          if (httpStatus(error) === 404) {
            return undefined;
          }
          throw error;
        }
      };
      const verifyHead = (object: typeof objects[number], result: HeadObjectCommandOutput | undefined): void => {
        if (!result || result.ContentLength !== object.bytes || result.Metadata?.['mpgd-sha256'] !== object.sha256
          || result.ChecksumSHA256 !== Buffer.from(object.sha256, 'hex').toString('base64')
          || result.ContentType !== object.mediaType || result.CacheControl !== immutableCacheControl) {
          fail(
            'collision',
            'Stored object does not match immutable bytes, checksum or delivery metadata; use a new revision/prefix',
          );
        }
      };
      for (const object of objects) {
        const bytes = await bytesFor(object);
        const existing = await head(object.key);
        let action: 'uploaded' | 'reused';
        if (existing) {
          verifyHead(object, existing);
          action = 'reused';
        } else {
          action = 'uploaded';
          try {
            await request((attemptSignal) =>
              client!.send(
                new PutObjectCommand({
                  Bucket: options.bucket,
                  Key: object.key,
                  Body: bytes,
                  ContentLength: object.bytes,
                  ContentType: object.mediaType,
                  CacheControl: immutableCacheControl,
                  IfNoneMatch: '*',
                  ChecksumSHA256: Buffer.from(object.sha256, 'hex').toString('base64'),
                  Metadata: { 'mpgd-sha256': object.sha256 },
                }),
                { abortSignal: attemptSignal },
              ),
            );
          } catch (error) {
            if (httpStatus(error) !== 412) {
              throw error;
            }
            action = 'reused';
          }
          verifyHead(object, await head(object.key));
        }
        results.push({ key: object.key, bytes: object.bytes, sha256: object.sha256, action });
      }
    }
    return {
      dryRun: options.dryRun === true,
      endpoint: endpoint.href,
      bucket: options.bucket,
      prefix,
      manifestSha256,
      plannedBytes,
      uploadedBytes: results.filter((object) => object.action === 'uploaded').reduce(
        (sum, object) => sum + object.bytes,
        0,
      ),
      objects: results,
    };
  } catch (error) {
    if (signal.aborted) {
      return fail(
        options.signal?.aborted ? 'cancelled' : 'timeout',
        'Asset publication was cancelled or exceeded its deadline',
      );
    }
    if (error instanceof AssetPackPublicationError) {
      throw error;
    }
    const status = httpStatus(error);
    // Do not surface SDK messages, XML responses, signed URLs, headers or causes.
    return fail(
      client === undefined ? 'source' : 's3',
      status === undefined
        ? 'Asset publication failed'
        : `Asset publication failed with HTTP ${status}`,
    );
  } finally {
    client?.destroy();
  }
}
