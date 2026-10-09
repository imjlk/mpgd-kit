import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { openPromise } from 'yauzl';
import {
  assertAssetPackTargetArtifact,
  assetPackTargetManifestName,
  assetPackTargetNamespace,
  assetPackTargetPolicyName,
  type AssetPackTargetReport,
} from './asset-pack-target.js';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const manifestSuffix = `/${assetPackTargetNamespace}/${assetPackTargetManifestName}`;

function expectedNamespace(artifact: string, namespace: string): boolean {
  switch (extname(artifact)) {
    case '.apk':
      return namespace === `assets/public/${assetPackTargetNamespace}/`;
    case '.aab':
      return namespace === `base/assets/public/${assetPackTargetNamespace}/`;
    case '.ipa':
      return new RegExp(`^Payload/[^/]+\\.app/public/${assetPackTargetNamespace}/$`).test(
        namespace,
      );
    case '.app':
      return namespace === `public/${assetPackTargetNamespace}/`;
    case '.xcarchive':
      return new RegExp(`^Products/Applications/[^/]+\\.app/public/${assetPackTargetNamespace}/$`).test(
        namespace,
      );
    default:
      return basename(artifact) === 'capacitor-sync' && namespace === `App/App/public/${assetPackTargetNamespace}/`;
  }
}

/** Inspect the actual native release, not only its pre-sync web input.
 * Hash one expanded entry at a time without extracting or executing anything.
 * Bounds: 2 GiB archive, 512 MiB/entry, 4 GiB expanded, 100000 entries. */
export async function assertAssetPackNativeArtifact(report: AssetPackTargetReport, artifact: string): Promise<void> {
  const path = resolve(artifact);
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    throw new Error('Native asset artifact must not be a symbolic link');
  }
  if (stat.isDirectory()) {
    const candidates: string[] = [];
    const pending = [path];
    let entries = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 100_000 || entry.isSymbolicLink()) {
          throw new Error(
            'Native asset artifact inventory is excessive or contains a symbolic link',
          );
        }
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(file);
        } else if (entry.name === assetPackTargetManifestName && basename(directory) === assetPackTargetNamespace) {
          candidates.push(relative(path, directory));
        }
      }
    }
    if (candidates.length !== 1) {
      throw new Error('Native asset artifact requires exactly one packaged pack namespace');
    }
    if (!expectedNamespace(path, candidates[0]!.replaceAll('\\', '/') + '/')) {
      throw new Error('Native asset namespace is outside the platform web bundle');
    }
    await assertAssetPackTargetArtifact(report, path, candidates[0]!);
    return;
  }
  if (!stat.isFile() || stat.size > 2 * 1024 ** 3) {
    throw new Error('Native asset archive is not a bounded regular file');
  }
  const localHashes = new Set(
    report.objects.filter((object) => object.location === 'packaged').map((object) => object.sha256),
  );
  const remoteHashes = new Set(
    report.objects.filter((object) => object.location === 'remote' && !localHashes.has(object.sha256)).map(
      (object) => object.sha256,
    ),
  );
  const files = new Map<string, { bytes: number; sha256: string }>();
  let expanded = 0;
  let entryCount = 0;
  const archive = await openPromise(path, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    for await (const entry of archive.eachEntry()) {
      if (++entryCount > 100_000 || entry.uncompressedSize > 512 * 1024 ** 2
        || expanded + entry.uncompressedSize > 4 * 1024 ** 3) {
        throw new Error('Native asset archive exceeds its inspection bounds');
      }
      if (entry.fileName.endsWith('/')) {
        continue;
      }
      if (files.has(entry.fileName)) {
        throw new Error('Native asset archive contains duplicate entries');
      }
      const stream = await archive.openReadStreamPromise(entry);
      const hash = createHash('sha256');
      let bytes = 0;
      try {
        for await (const chunk of stream) {
          bytes += (chunk as Buffer).length;
          if (bytes > entry.uncompressedSize) {
            throw new Error('Native asset entry exceeds its declared size');
          }
          hash.update(chunk);
        }
      } finally {
        stream.destroy();
      }
      expanded += bytes;
      if (bytes !== entry.uncompressedSize) {
        throw new Error('Native asset entry has a mismatched expanded size');
      }
      const sha256 = hash.digest('hex');
      if (remoteHashes.has(sha256)) {
        throw new Error(
          `Remote-only asset object is present in the native package: ${entry.fileName}`,
        );
      }
      files.set(entry.fileName, { bytes, sha256 });
    }
  } finally {
    archive.close();
  }
  const namespaces = [...files.keys()].filter((name) => name.endsWith(manifestSuffix)).map((name) =>
    name.slice(0, -assetPackTargetManifestName.length),
  );
  if (namespaces.length !== 1) {
    throw new Error('Native asset package requires exactly one packaged pack namespace');
  }
  const namespace = namespaces[0]!;
  if (!expectedNamespace(path, namespace)) {
    throw new Error('Native asset namespace is outside the platform web bundle');
  }
  const namespaceBytes = [...files].filter(([name]) => name.startsWith(namespace)).reduce(
    (sum, [, file]) => sum + file.bytes,
    0,
  );
  if (namespaceBytes !== report.packagedBytes) {
    throw new Error('Native packaged asset namespace has extra, missing or modified bytes');
  }
  for (const name of [assetPackTargetManifestName, assetPackTargetPolicyName]) {
    if (files.get(namespace + name)?.sha256 !== digest(await readFile(join(report.packagedDir, name)))) {
      throw new Error('Native packaged asset metadata changed');
    }
  }
  for (const object of report.objects.filter((object) => object.location === 'packaged')) {
    if (files.get(namespace + object.path)?.sha256 !== object.sha256) {
      throw new Error('Native packaged asset object changed');
    }
  }
}
