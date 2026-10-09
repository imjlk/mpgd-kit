import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  validatePhaserPackBuildConfig,
  validatePhaserPackDeliveryManifest,
  type PhaserPackDeliveryFile,
} from '@mpgd/phaser-assets/pack-format';
import {
  assertAssetPackTargetPolicy,
  resolveAssetPackLocations,
  type AssetPackDeliveryPolicy,
  type AssetPackLocation,
  type AssetPackTargetPolicy,
} from '@mpgd/target-config/asset-packs';
import { buildAssetPacks } from './asset-pack-build.js';
import { verifyAssetPackDelivery } from './asset-pack-verify.js';

export const assetPackTargetNamespace = 'mpgd-asset-packs';
export const assetPackTargetManifestName = 'asset-pack-delivery.json';
export const assetPackTargetPolicyName = 'target-policy.json';

export interface AssetPackTargetReport {
  readonly outDir: string;
  readonly packagedDir: string;
  readonly remoteDir: string;
  readonly manifestSha256: string;
  readonly locations: Readonly<Record<string, AssetPackLocation>>;
  readonly packagedAssetBytes: number;
  readonly packagedBytes: number;
  readonly remoteBytes: number;
  readonly objects: readonly { readonly path: string; readonly bytes: number; readonly sha256: string; readonly location: AssetPackLocation }[];
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
function inside(parent: string, child: string): boolean {
  const step = relative(parent, child);
  return step === '' || (!isAbsolute(step) && step !== '..' && !step.startsWith(`..${sep}`));
}
async function noSymlink(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (stat?.isSymbolicLink()) {
      // macOS exposes its system temporary directories through these fixed
      // aliases. Accept only their canonical OS targets, never user links.
      const systemAlias = process.platform === 'darwin'
        && ((current === '/var' && await realpath(current) === '/private/var')
          || (current === '/tmp' && await realpath(current) === '/private/tmp'));
      if (!systemAlias) {
        throw new Error(`Asset target path must not traverse a symbolic link: ${path}`);
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function canonicalOutput(path: string): Promise<string> {
  let ancestor = path;
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      return resolve(canonical, relative(ancestor, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        throw error;
      }
      ancestor = parent;
    }
  }
}

/** Stage verified immutable objects into disjoint packaged/remote roots.
 * The output must not exist: a failed attempt never replaces a deployment. */
export async function stageAssetPackTarget(options: {
  readonly manifestPath: string;
  readonly root: string;
  readonly policy: AssetPackDeliveryPolicy;
  readonly outDir: string;
}): Promise<AssetPackTargetReport> {
  await noSymlink(options.root);
  await noSymlink(options.manifestPath);
  const root = await realpath(resolve(options.root));
  await noSymlink(options.outDir);
  const out = await canonicalOutput(resolve(options.outDir));
  if (inside(root, out) || inside(out, root)) {
    throw new Error('Asset target output must be disjoint from the delivery source root');
  }
  if (await lstat(out).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  })) {
    throw new Error('Asset target output already exists; choose a fresh deployment directory');
  }
  const verified = await verifyAssetPackDelivery({
    manifestPath: options.manifestPath,
    root,
    hostLimits: { maxFiles: 100_000, maxTotalBytes: 1024 ** 3 },
  });
  if (!verified.ok) {
    throw new Error(
      `Asset target source verification failed: ${verified.failures.map((failure) => failure.code).join(', ')}`,
    );
  }
  const manifestBytes = await readFile(options.manifestPath);
  if (digest(manifestBytes) !== verified.manifest.sha256) {
    throw new Error('Delivery manifest changed during target staging');
  }
  const manifest = validatePhaserPackDeliveryManifest(JSON.parse(manifestBytes.toString('utf8')));
  const locations = resolveAssetPackLocations(options.policy, manifest.packs);
  const runtimePolicy: AssetPackDeliveryPolicy = {
    defaultLocation: 'packaged',
    packs: locations,
    ...(options.policy.offlineRequired === undefined ? {} : { offlineRequired: [...options.policy.offlineRequired] }),
    ...(options.policy.remoteBaseUrl === undefined ? {} : { remoteBaseUrl: options.policy.remoteBaseUrl }),
    ...(options.policy.maxPackagedBytes === undefined ? {} : { maxPackagedBytes: options.policy.maxPackagedBytes }),
  };
  const policyBytes = Buffer.from(JSON.stringify(runtimePolicy, null, 2) + '\n');
  const objects = new Map<string, AssetPackTargetReport['objects'][number]>();
  for (const pack of manifest.packs) {
    const files: readonly Pick<PhaserPackDeliveryFile, 'path' | 'bytes' | 'sha256'>[] = pack.delivery === 'zip'
      ? [pack.archive!]
      : pack.assets.flatMap((asset) => asset.files);
    for (const file of files) {
      const location = locations[pack.packId]!;
      objects.set(`${location}:${file.path}`, {
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        location,
      });
    }
  }
  const planned = [...objects.values()].sort(
    (a, b) => a.location.localeCompare(b.location) || a.path.localeCompare(b.path),
  );
  const packagedAssetBytes = planned.filter((object) => object.location === 'packaged').reduce(
    (sum, object) => sum + object.bytes,
    0,
  );
  const packagedBytes = packagedAssetBytes + manifestBytes.length + policyBytes.length;
  if (options.policy.maxPackagedBytes !== undefined && packagedBytes > options.policy.maxPackagedBytes) {
    throw new Error(
      `Packaged asset namespace exceeds its budget: ${packagedBytes} > ${options.policy.maxPackagedBytes}`,
    );
  }
  await mkdir(dirname(out), { recursive: true });
  const temporary = await mkdtemp(join(dirname(out), '.mpgd-asset-target-'));
  try {
    await mkdir(join(temporary, 'packaged'));
    await mkdir(join(temporary, 'remote'));
    for (const object of planned) {
      const source = join(root, object.path);
      await noSymlink(source);
      const destination = join(temporary, object.location, object.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      const stat = await lstat(destination);
      if (stat.size !== object.bytes || await fileDigest(destination) !== object.sha256) {
        throw new Error(`Asset object changed during target staging: ${object.path}`);
      }
    }
    await writeFile(join(temporary, 'packaged', assetPackTargetManifestName), manifestBytes);
    await writeFile(join(temporary, 'packaged', assetPackTargetPolicyName), policyBytes);
    await rename(temporary, out);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return {
    outDir: out,
    packagedDir: join(out, 'packaged'),
    remoteDir: join(out, 'remote'),
    manifestSha256: verified.manifest.sha256,
    locations,
    packagedAssetBytes,
    packagedBytes,
    remoteBytes: planned.filter((object) => object.location === 'remote').reduce(
      (sum, object) => sum + object.bytes,
      0,
    ),
    objects: planned,
  };
}

/** Build from one target's policy without requiring a kit checkout. */
export async function assertAssetPackTargetOutput(options: {
  readonly policy: AssetPackTargetPolicy;
  readonly baseDir: string;
  readonly outDir: string;
}): Promise<void> {
  assertAssetPackTargetPolicy(options.policy);
  const configPath = resolve(options.baseDir, options.policy.buildConfig);
  const config = validatePhaserPackBuildConfig(JSON.parse(await readFile(configPath, 'utf8')));
  const sourceRoot = await realpath(resolve(dirname(configPath), config.root));
  await noSymlink(options.outDir);
  const output = await canonicalOutput(resolve(options.outDir));
  if (inside(sourceRoot, output) || inside(output, sourceRoot)) {
    throw new Error('Asset target output must be disjoint from the original asset source root');
  }
  if (inside(output, await realpath(configPath))) {
    throw new Error('Asset target output must not replace its build config');
  }
}

export async function buildAssetPackTarget(options: {
  readonly policy: AssetPackTargetPolicy;
  readonly baseDir: string;
  readonly outDir: string;
}): Promise<AssetPackTargetReport> {
  await assertAssetPackTargetOutput(options);
  const configPath = resolve(options.baseDir, options.policy.buildConfig);
  const temporary = await mkdtemp(join(tmpdir(), 'mpgd-asset-source-'));
  try {
    const built = buildAssetPacks({
      configPath,
      outDir: join(temporary, 'delivery'),
    });
    return await stageAssetPackTarget({
      manifestPath: built.manifestPath,
      root: built.outDir,
      policy: options.policy,
      outDir: options.outDir,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Verify the real bundle's asset namespace and reject byte-identical remote
 * objects copied elsewhere. This does not inspect transformed/embedded data. */
export async function assertAssetPackTargetArtifact(
  report: AssetPackTargetReport,
  artifactRoot: string,
  namespacePath = assetPackTargetNamespace,
): Promise<void> {
  const root = resolve(artifactRoot);
  const namespace = resolve(root, namespacePath);
  if (!inside(root, namespace) || namespace === root) {
    throw new Error('Asset namespace must be inside the target artifact');
  }
  const localHashes = new Set(
    report.objects.filter((object) => object.location === 'packaged').map((object) => object.sha256),
  );
  const remoteHashes = new Set(
    report.objects.filter((object) => object.location === 'remote' && !localHashes.has(object.sha256)).map(
      (object) => object.sha256,
    ),
  );
  let count = 0;
  let namespaceBytes = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (++count > 100_000 || entry.isSymbolicLink()) {
        throw new Error('Asset artifact inventory exceeds its limit or contains a symbolic link');
      }
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        if (inside(namespace, path)) {
          namespaceBytes += (await lstat(path)).size;
        }
        if (remoteHashes.has(await fileDigest(path))) {
          throw new Error(
            `Remote-only asset object is present in the packaged artifact: ${relative(root, path)}`,
          );
        }
      } else {
        throw new Error('Asset artifact contains a non-regular entry');
      }
    }
  }
  if (namespaceBytes !== report.packagedBytes) {
    throw new Error('Packaged asset namespace has extra, missing or modified bytes');
  }
  for (const name of [assetPackTargetManifestName, assetPackTargetPolicyName]) {
    if (await fileDigest(join(namespace, name)) !== await fileDigest(join(report.packagedDir, name))) {
      throw new Error(`Packaged asset metadata changed: ${name}`);
    }
  }
  for (const object of report.objects.filter((object) => object.location === 'packaged')) {
    if (await fileDigest(join(namespace, object.path)) !== object.sha256) {
      throw new Error(`Packaged asset object changed: ${object.path}`);
    }
  }
}
