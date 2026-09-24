import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { buildAssetPacks } from '../../packages/cli/src/asset-pack-build';
import {
  verifyAssetPackDelivery,
  type AssetPackVerifyReport,
} from '../../packages/cli/src/asset-pack-verify';

const repoRoot = resolve('.');
const fixtureRoot = join('node_modules', '.cache', 'mpgd-cli-asset-pack-verify');
const sourceRoot = join(fixtureRoot, 'src');
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const incompressible = (length: number, seed: number): Buffer => {
  let state = seed >>> 0;
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
};
const pilotPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  incompressible(2048, 7),
]);
const grovePng = incompressible(4096, 11);
const groveJson = Buffer.from(
  `${JSON.stringify({ frames: { ground: { frame: { x: 0, y: 0, w: 8, h: 8 } } } })}\n`,
  'utf8',
);
const dunesPng = incompressible(1536, 23);

const runVerifyCli = (
  manifest: string,
  root: string,
  ...extra: readonly string[]
): SpawnSyncReturns<string> => spawnSync(
  process.execPath,
  [
    'tools/run-ttsx.mjs',
    '--mpgd-cli',
    'packages/cli/src/bin.ts',
    'assets',
    'verify-delivery',
    '--manifest',
    manifest,
    '--root',
    root,
    ...extra,
  ],
  { cwd: repoRoot, encoding: 'utf8' },
);

const verify = async (
  manifest: string,
  root: string,
  options?: Omit<Parameters<typeof verifyAssetPackDelivery>[0], 'manifestPath' | 'root'>,
): Promise<AssetPackVerifyReport> => verifyAssetPackDelivery({
  manifestPath: manifest,
  root,
  ...(options === undefined ? {} : options),
});

const buildFixture = (delivery: 'files' | 'zip', out: string): void => {
  writeJson(join(fixtureRoot, `config-${delivery}.json`), {
    root: 'src',
    packs: [
      {
        id: 'shared',
        revision: '1',
        delivery,
        assets: [
          {
            kind: 'spritesheet',
            key: 'pilot',
            file: 'pilot.png',
            frameConfig: { frameWidth: 8, frameHeight: 8 },
          },
        ],
      },
      {
        id: 'grove',
        revision: '1',
        dependsOn: ['shared'],
        delivery,
        assets: [{ kind: 'atlas', key: 'ground', texture: 'grove.png', atlas: 'grove.json' }],
      },
    ],
  });
  buildAssetPacks({
    configPath: `config-${delivery}.json`,
    outDir: out,
    cwd: fixtureRoot,
  });
};

const inputsUnchanged = (
  before: Map<string, { bytes: number; sha256: string }>,
  after: Map<string, { bytes: number; sha256: string }>,
): void => {
  for (const [path, stats] of before) {
    const later = after.get(path);
    assert.ok(later !== undefined, `input vanished: ${path}`);
    assert.equal(later.bytes, stats.bytes, `input size changed: ${path}`);
    assert.equal(later.sha256, stats.sha256, `input bytes changed: ${path}`);
  }
};

const snapshotTree = (root: string): Map<string, { bytes: number; sha256: string }> => {
  const map = new Map<string, { bytes: number; sha256: string }>();
  const walk = (directory: string): void => {
    for (const entry of existsSync(directory)
      ? readdirSync(directory, { withFileTypes: true })
      : []) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const data = readFileSync(path);
      map.set(path, { bytes: data.byteLength, sha256: sha256(data) });
    }
  };
  walk(root);
  return map;
};

// ---- Fixture setup -------------------------------------------------------
rmSync(fixtureRoot, { force: true, recursive: true });
mkdirSync(sourceRoot, { recursive: true });
writeFileSync(join(sourceRoot, 'pilot.png'), pilotPng);
writeFileSync(join(sourceRoot, 'grove.png'), grovePng);
writeFileSync(join(sourceRoot, 'grove.json'), groveJson);
writeFileSync(join(sourceRoot, 'dunes.png'), dunesPng);
const filesOut = 'out-files';
const zipOut = 'out-zip';
buildFixture('files', filesOut);
buildFixture('zip', zipOut);
const under = (out: string, relative: string): string => join(fixtureRoot, out, relative);
const filesManifest = join(fixtureRoot, filesOut, 'asset-pack-delivery.json');
const zipManifest = join(fixtureRoot, zipOut, 'asset-pack-delivery.json');
// Mixed: shared as files, grove as zip, in one root.
const mixedOut = 'out-mixed';
buildFixture('files', mixedOut);
{
  const manifest = JSON.parse(
    readFileSync(under(mixedOut, 'asset-pack-delivery.json'), 'utf8'),
  ) as {
    packs: { packId: string }[];
  };
  const zipManifestDoc = JSON.parse(readFileSync(zipManifest, 'utf8')) as {
    packs: { packId: string; delivery: string }[];
  };
  const groveZip = zipManifestDoc.packs.find((pack) => pack.packId === 'grove')!;
  manifest.packs = manifest.packs.map((pack) =>
    pack.packId === 'grove' ? { ...groveZip } : pack,
  );
  writeJson(under(mixedOut, 'asset-pack-delivery.json'), manifest);
  cpSync(
    join(fixtureRoot, zipOut, 'packs', 'grove@1.zip'),
    join(fixtureRoot, mixedOut, 'packs', 'grove@1.zip'),
  );
}
const mixedManifest = join(fixtureRoot, mixedOut, 'asset-pack-delivery.json');
const outputDirs = new Map<string, string>([
  ['files', filesOut],
  ['zip', zipOut],
  ['mixed', mixedOut],
]);
const beforeSnapshot = new Map<string, Map<string, { bytes: number; sha256: string }>>(
  [...outputDirs].map(([label, dir]) => [label, snapshotTree(join(fixtureRoot, dir))]),
);

// ---- Happy paths ---------------------------------------------------------
{
  const report = await verify(filesManifest, join(fixtureRoot, filesOut));
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.manifest.packs, 2);
  assert.equal(report.referenced.files, 3);
  assert.equal(
    report.referenced.bytes,
    pilotPng.byteLength + grovePng.byteLength + groveJson.byteLength,
  );
  assert.equal(report.archives.length, 0);
  assert.ok(report.manifest.sha256.length === 64);
  assert.ok(report.notVerified.length > 0);
}
{
  const report = await verify(zipManifest, join(fixtureRoot, zipOut));
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.referenced.files, 2);
  assert.equal(report.archives.length, 2);
  const grove = report.archives.find((archive) => archive.packId === 'grove')!;
  assert.ok(grove !== undefined);
  assert.equal(grove.entries, 2);
  assert.equal(grove.expandedBytes, grovePng.byteLength + groveJson.byteLength);
}
{
  // Mixed manifests: files and zip packs live side by side in one root.
  const report = await verify(mixedManifest, join(fixtureRoot, mixedOut));
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.referenced.files, 2);
  assert.equal(report.archives.length, 1);
}
{
  // Old revisions coexisting in the root must not fail the check.
  const agedRoot = join(fixtureRoot, 'out-aged');
  cpSync(join(fixtureRoot, zipOut), agedRoot, { recursive: true });
  mkdirSync(join(agedRoot, 'packs', 'shared@old'), { recursive: true });
  writeFileSync(join(agedRoot, 'packs', 'shared@old', 'stale.zip'), incompressible(64, 99));
  const report = await verify(zipManifest, agedRoot);
  assert.equal(report.ok, true, JSON.stringify(report.failures));
}

// ---- Determinism ----------------------------------------------------------
{
  const first = await verify(zipManifest, join(fixtureRoot, zipOut));
  const second = await verify(zipManifest, join(fixtureRoot, zipOut));
  assert.deepEqual(second, first);
}

// ---- Failure paths ---------------------------------------------------------
{
  const report = await verify(join(fixtureRoot, 'missing.json'), join(fixtureRoot, zipOut));
  assert.equal(report.ok, false);
  assert.equal(report.failures[0]!.stage, 'manifest');
  assert.equal(report.failures[0]!.code, 'manifest-unreadable');
}
{
  const badJson = join(fixtureRoot, 'bad.json');
  writeFileSync(badJson, '{not json');
  const report = await verify(badJson, join(fixtureRoot, zipOut));
  assert.equal(report.ok, false);
  assert.equal(report.failures[0]!.code, 'manifest-invalid');
}
{
  const report = await verify(zipManifest, join(fixtureRoot, 'nowhere'));
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((failure) => failure.code === 'root-missing'));
}
{
  // Missing referenced file.
  const holeRoot = join(fixtureRoot, 'out-hole');
  cpSync(join(fixtureRoot, filesOut), holeRoot, { recursive: true });
  rmSync(join(holeRoot, 'packs', 'grove@1', 'grove.json'));
  const report = await verify(join(holeRoot, 'asset-pack-delivery.json'), holeRoot);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some((failure) => failure.stage === 'paths' && failure.code === 'path-invalid'),
  );
}
{
  // Size mismatch: file longer than declared.
  const sizeRoot = join(fixtureRoot, 'out-size');
  cpSync(join(fixtureRoot, filesOut), sizeRoot, { recursive: true });
  writeFileSync(
    join(sizeRoot, 'packs', 'grove@1', 'grove.png'),
    Buffer.concat([grovePng, Buffer.from('extra')]),
  );
  const report = await verify(join(sizeRoot, 'asset-pack-delivery.json'), sizeRoot);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some((failure) => failure.stage === 'files' && failure.code === 'size-mismatch'),
  );
}
{
  // Hash mismatch: same size, different bytes.
  const hashRoot = join(fixtureRoot, 'out-hash');
  cpSync(join(fixtureRoot, filesOut), hashRoot, { recursive: true });
  const flipped = Buffer.from(grovePng);
  flipped[0] = (flipped[0] ?? 0) ^ 0xff;
  writeFileSync(join(hashRoot, 'packs', 'grove@1', 'grove.png'), flipped);
  const report = await verify(join(hashRoot, 'asset-pack-delivery.json'), hashRoot);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some((failure) => failure.stage === 'files' && failure.code === 'hash-mismatch'),
  );
}
{
  // Corrupt zip archive: the internal digest check must fail with the
  // core's archive-mismatch code surfaced through the zip- prefix.
  const corruptRoot = join(fixtureRoot, 'out-corrupt');
  cpSync(join(fixtureRoot, zipOut), corruptRoot, { recursive: true });
  const archivePath = join(corruptRoot, 'packs', 'grove@1.zip');
  const bytes = readFileSync(archivePath);
  bytes[bytes.byteLength - 3] = (bytes[bytes.byteLength - 3] ?? 0) ^ 0xff;
  writeFileSync(archivePath, bytes);
  const manifestDoc = JSON.parse(
    readFileSync(join(corruptRoot, 'asset-pack-delivery.json'), 'utf8'),
  ) as {
    packs: { packId: string; archive?: { sha256: string } }[];
  };
  // Refresh the archive digest so verification reaches the interior and
  // fails on structure, not on the archive hash.
  const grove = manifestDoc.packs.find((pack) => pack.packId === 'grove')!;
  grove.archive!.sha256 = sha256(bytes);
  writeJson(join(corruptRoot, 'asset-pack-delivery.json'), manifestDoc);
  const report = await verify(join(corruptRoot, 'asset-pack-delivery.json'), corruptRoot);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(
      (failure) => failure.stage === 'archive' && failure.code.startsWith('zip-'),
    ),
    JSON.stringify(report.failures),
  );
}
{
  // Structure mutation with refreshed archive hash: a truncated interior
  // must fail at the structure stage, not the hash stage.
  const structureRoot = join(fixtureRoot, 'out-structure');
  cpSync(join(fixtureRoot, zipOut), structureRoot, { recursive: true });
  const archivePath = join(structureRoot, 'packs', 'shared@1.zip');
  // Zero the CRC of the local header: same size, digest refreshed below.
  const bytes = readFileSync(archivePath);
  bytes[14] = (bytes[14] ?? 0) ^ 0xff;
  bytes[15] = (bytes[15] ?? 0) ^ 0xff;
  writeFileSync(archivePath, bytes);
  const manifestDoc = JSON.parse(
    readFileSync(join(structureRoot, 'asset-pack-delivery.json'), 'utf8'),
  ) as { packs: { packId: string; archive?: { sha256: string } }[]; format: string; version: number };
  const shared = manifestDoc.packs.find((pack) => pack.packId === 'shared')!;
  shared.archive!.sha256 = sha256(bytes);
  writeJson(join(structureRoot, 'asset-pack-delivery.json'), manifestDoc);
  const report = await verify(join(structureRoot, 'asset-pack-delivery.json'), structureRoot);
  assert.equal(report.ok, false);
  assert.ok(
    report.failures.some(
      (failure) => failure.stage === 'archive' && failure.code.startsWith('zip-'),
    ),
    JSON.stringify(report.failures),
  );
}
{
  // A symlink replacing a referenced artifact must be rejected.
  const { symlinkSync } = await import('node:fs');
  const linkRoot = join(fixtureRoot, 'out-link');
  cpSync(join(fixtureRoot, filesOut), linkRoot, { recursive: true });
  const target = join(linkRoot, 'packs', 'grove@1', 'grove.png');
  rmSync(target);
  symlinkSync(join(fixtureRoot, 'src', 'grove.png'), target);
  const report = await verify(join(linkRoot, 'asset-pack-delivery.json'), linkRoot);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((failure) => failure.stage === 'paths'));
}
{
  // A root that is an existing regular file must fail, not silently
  // skip every stage and pass.
  const fileRoot = join(fixtureRoot, 'root-as-file.bin');
  writeFileSync(fileRoot, 'not a directory');
  const report = await verify(zipManifest, fileRoot);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((failure) => failure.code === 'root-missing'));
  assert.equal(report.referenced.files, 2);
}
{
  // A manifest FIFO whose writer never sends data never delivers a chunk
  // to sample; the stream watchdog must abort it at the deadline instead
  // of hanging forever.
  const fifoPath = join(fixtureRoot, 'stalled-manifest.fifo');
  const fifoResult = spawnSync('mkfifo', [fifoPath]);
  assert.equal(
    fifoResult.status,
    0,
    fifoResult.error?.message ?? fifoResult.stderr?.toString() ?? 'mkfifo failed',
  );
  // Keep the writer process owned by this test. A detached shell background
  // job can exit before the deadline on CI and turn this into an EOF test.
  const writer = spawn(
    process.execPath,
    [
      '-e',
      [
        'require("node:fs").openSync(process.argv[1], "w");',
        'setTimeout(() => process.exit(0), 10000);',
        'setInterval(() => {}, 1000);',
      ].join(' '),
      fifoPath,
    ],
    { stdio: 'ignore' },
  );
  const writerDone = new Promise<void>((resolve, reject) => {
    writer.once('close', () => resolve());
    writer.once('error', reject);
  });
  try {
    const startedAt = performance.now();
    const report = await verifyAssetPackDelivery({
      manifestPath: fifoPath,
      root: join(fixtureRoot, zipOut),
      verifyTimeoutMs: 300,
    });
    assert.ok(performance.now() - startedAt < 5000, 'FIFO deadline returned too late.');
    assert.equal(report.ok, false);
    assert.ok(
      report.failures.some((failure) => failure.code === 'deadline'),
      JSON.stringify(report.failures),
    );
  } finally {
    writer.kill();
    await writerDone.catch(() => {});
    rmSync(fifoPath, { force: true });
  }
}
{
  // A FIFO with real manifest bytes must still parse and verify normally.
  const fifoPath = join(fixtureRoot, 'streamed-manifest.fifo');
  const fifoResult = spawnSync('mkfifo', [fifoPath]);
  assert.equal(fifoResult.status, 0, fifoResult.error?.message ?? 'mkfifo failed');
  const writer = spawn(process.execPath, [
    '-e',
    'require("node:fs").writeFileSync(process.argv[1], require("node:fs").readFileSync(process.argv[2]));',
    fifoPath,
    zipManifest,
  ], { stdio: 'ignore' });
  const writerDone = new Promise<void>((resolve, reject) => {
    writer.once('close', () => resolve());
    writer.once('error', reject);
  });
  try {
    const report = await verifyAssetPackDelivery({
      manifestPath: fifoPath,
      root: join(fixtureRoot, zipOut),
      verifyTimeoutMs: 5000,
    });
    assert.equal(report.ok, true, JSON.stringify(report.failures));
  } finally {
    writer.kill();
    await writerDone.catch(() => {});
    rmSync(fifoPath, { force: true });
  }
}
{
  // Traversal: manifest path escaping the root.
  const escapeRoot = join(fixtureRoot, 'out-escape');
  cpSync(join(fixtureRoot, filesOut), escapeRoot, { recursive: true });
  const manifestDoc = JSON.parse(
    readFileSync(
      join(
        escapeRoot,
        'asset-pack-delivery.json',
      ),
      'utf8',
    ),
  ) as { packs: { packId: string; assets: { files: { path: string }[] }[] }[] };
  manifestDoc.packs[0]!.assets[0]!.files[0]!.path = '../../../src/pilot.png';
  writeJson(join(escapeRoot, 'asset-pack-delivery.json'), manifestDoc);
  const report = await verify(join(escapeRoot, 'asset-pack-delivery.json'), escapeRoot);
  assert.equal(report.ok, false);
  // The manifest validator rejects '..' components outright, so the escape
  // surfaces as a manifest rejection; the tool's own traversal branch is
  // defense in depth behind that.
  assert.ok(
    report.failures.some(
      (failure) => failure.stage === 'manifest'
        || (failure.stage === 'paths' && failure.message.includes('escapes')),
    ),
    JSON.stringify(report.failures),
  );
}
{
  // A manifest referencing a directory instead of a file.
  const dirRoot = join(fixtureRoot, 'out-dirref');
  cpSync(join(fixtureRoot, filesOut), dirRoot, { recursive: true });
  const dirDoc = JSON.parse(
    readFileSync(
      join(
        dirRoot,
        'asset-pack-delivery.json',
      ),
      'utf8',
    ),
  ) as { packs: { packId: string; assets: { files: { path: string }[] }[] }[] };
  dirDoc.packs[0]!.assets[0]!.files[0]!.path = 'packs/grove@1';
  writeJson(join(dirRoot, 'asset-pack-delivery.json'), dirDoc);
  {
    const report = await verify(join(dirRoot, 'asset-pack-delivery.json'), dirRoot);
    assert.equal(report.ok, false);
    assert.ok(
      report.failures.some(
        (failure) => failure.stage === 'paths' && failure.message.includes('regular file'),
      ),
      JSON.stringify(report.failures),
    );
  }
  // Invalid numeric options.
  const report = await verify(zipManifest, join(fixtureRoot, zipOut), {
    hostLimits: { maxFiles: 1.5 },
  });
  assert.equal(report.ok, false);
  assert.equal(report.failures[0]!.stage, 'args');
  assert.equal(report.failures[0]!.code, 'invalid-option');
  const overRange = await verify(zipManifest, join(fixtureRoot, zipOut), {
    verifyTimeoutMs: 2 ** 31,
  });
  assert.equal(overRange.ok, false);
  assert.ok(overRange.failures.some((failure) => failure.code === 'invalid-option'));
  // Invalid arguments stop all filesystem work before the manifest is
  // even read: the deadline itself may be the invalid value.
  assert.equal(report.failures.length, 1);
  assert.equal(report.referenced.files, 0);
  assert.equal(report.inventory, undefined);
}
{
  // Host limits: inventory over count/bytes limits (old revisions count).
  const limitedRoot = join(fixtureRoot, 'out-limited');
  cpSync(join(fixtureRoot, filesOut), limitedRoot, { recursive: true });
  writeFileSync(join(limitedRoot, 'packs', 'legacy.bin'), incompressible(32, 5));
  const overFiles = await verify(join(limitedRoot, 'asset-pack-delivery.json'), limitedRoot, {
    hostLimits: { maxFiles: 2 },
  });
  assert.equal(overFiles.ok, false);
  assert.ok(overFiles.failures.some((failure) => failure.code === 'max-files'));
  assert.ok(overFiles.inventory !== undefined && overFiles.inventory.files > 2);
  const overTotal = await verify(join(limitedRoot, 'asset-pack-delivery.json'), limitedRoot, {
    hostLimits: { maxTotalBytes: 64 },
  });
  assert.equal(overTotal.ok, false);
  assert.ok(overTotal.failures.some((failure) => failure.code === 'max-total-bytes'));
  const overObject = await verify(join(limitedRoot, 'asset-pack-delivery.json'), limitedRoot, {
    hostLimits: { maxObjectBytes: 8 },
  });
  assert.equal(overObject.ok, false);
  assert.ok(overObject.failures.some((failure) => failure.code === 'max-object-bytes'));
  const within = await verify(join(limitedRoot, 'asset-pack-delivery.json'), limitedRoot, {
    hostLimits: { maxFiles: 10_000, maxTotalBytes: 1024 * 1024, maxObjectBytes: 1024 * 1024 },
  });
  assert.equal(within.ok, true, JSON.stringify(within.failures));
}
{
  // The object-size limit covers unreferenced objects (stale revisions):
  // a huge artifact that no manifest entry points at still fails the cap.
  const objRoot = join(fixtureRoot, 'out-objsize');
  cpSync(join(fixtureRoot, filesOut), objRoot, { recursive: true });
  const manifestDoc = JSON.parse(
    readFileSync(
      join(
        objRoot,
        'asset-pack-delivery.json',
      ),
      'utf8',
    ),
  ) as { packs: { assets: { files: { bytes: number }[] }[] }[] };
  let declaredLargest = 0;
  for (const pack of manifestDoc.packs) {
    for (const asset of pack.assets) {
      for (const file of asset.files) {
        declaredLargest = Math.max(declaredLargest, file.bytes);
      }
    }
  }
  assert.ok(declaredLargest > 0);
  writeFileSync(join(objRoot, 'packs', 'huge.bin'), Buffer.alloc(declaredLargest + 1024, 7));
  const over = await verify(join(objRoot, 'asset-pack-delivery.json'), objRoot, {
    hostLimits: { maxObjectBytes: declaredLargest },
  });
  assert.equal(over.ok, false);
  assert.ok(over.failures.some((failure) => failure.code === 'max-object-bytes'));
  const withinObject = await verify(join(objRoot, 'asset-pack-delivery.json'), objRoot, {
    hostLimits: { maxObjectBytes: declaredLargest + 1024 },
  });
  assert.equal(withinObject.ok, true, JSON.stringify(withinObject.failures));
}
{
  // Referenced integrity alone must not report host limits as passed when
  // the inventory exceeds them: the two scopes stay distinct.
  const report = await verify(filesManifest, join(fixtureRoot, filesOut), {
    hostLimits: { maxFiles: 1 },
  });
  assert.equal(report.ok, false);
  assert.ok(report.inventory !== undefined);
  assert.ok(report.limits !== undefined);
}
{
  // Archive byte cap: a declared archive over the cap fails in the limits
  // stage before being read; a cap above the archive passes.
  const zipReport = await verify(zipManifest, join(fixtureRoot, zipOut));
  assert.equal(zipReport.ok, true, JSON.stringify(zipReport.failures));
  const manifestDoc = JSON.parse(readFileSync(zipManifest, 'utf8')) as {
    packs: { archive?: { bytes: number } }[];
  };
  const largestArchive = Math.max(...manifestDoc.packs.map((pack) => pack.archive?.bytes ?? 0));
  assert.ok(largestArchive > 0);
  const overCap = await verify(zipManifest, join(fixtureRoot, zipOut), {
    maxArchiveBytes: largestArchive - 1,
  });
  assert.equal(overCap.ok, false);
  assert.ok(overCap.failures.some((failure) => failure.code === 'max-archive-bytes'));
  const withinCap = await verify(zipManifest, join(fixtureRoot, zipOut), {
    maxArchiveBytes: largestArchive,
  });
  assert.equal(withinCap.ok, true, JSON.stringify(withinCap.failures));
}
{
  // Decompression bounds are independent of the manifest: over-cap
  // declared expansion fails before any decoding, pass-range caps do not.
  const expansionRoot = join(fixtureRoot, 'out-expansion');
  cpSync(join(fixtureRoot, zipOut), expansionRoot, { recursive: true });
  const expansionManifestPath = join(expansionRoot, 'asset-pack-delivery.json');
  const expansionManifest = JSON.parse(
    readFileSync(
      expansionManifestPath,
      'utf8',
    ),
  ) as { packs: { packId: string; assets: { files: { bytes: number }[] }[] }[] };
  const firstFiles = expansionManifest.packs[0]!.assets[0]!.files;
  const originalBytes = firstFiles[0]!.bytes;
  firstFiles[0]!.bytes = 512 * 1024 * 1024;
  writeJson(expansionManifestPath, expansionManifest);
  const overEntry = await verify(expansionManifestPath, expansionRoot);
  assert.equal(overEntry.ok, false);
  assert.ok(overEntry.failures.some((failure) => failure.code === 'max-entry-bytes'));
  // Caps apply per pack, so bound pack 0's own declared total.
  const firstPackTotal = expansionManifest.packs[0]!.assets.reduce(
    (sum, asset) => sum + asset.files.reduce((n, file) => n + file.bytes, 0),
    0,
  );
  const overExpanded = await verify(expansionManifestPath, expansionRoot, {
    maxEntryBytes: 1024 * 1024 * 1024,
    maxExpandedBytes: firstPackTotal - 1,
  });
  assert.equal(overExpanded.ok, false);
  assert.ok(overExpanded.failures.some((failure) => failure.code === 'max-expanded-bytes'));
  // Restoring the declared size and using pass-range caps verifies fully.
  firstFiles[0]!.bytes = originalBytes;
  writeJson(expansionManifestPath, expansionManifest);
  // Pass-range caps sit exactly at the largest entry and the largest
  // single-pack expansion across the whole manifest.
  let largestEntry = 0;
  let largestPackTotal = 0;
  for (const pack of expansionManifest.packs) {
    let packTotal = 0;
    for (const asset of pack.assets) {
      for (const file of asset.files) {
        largestEntry = Math.max(largestEntry, file.bytes);
        packTotal += file.bytes;
      }
    }
    largestPackTotal = Math.max(largestPackTotal, packTotal);
  }
  const withinExpansion = await verify(expansionManifestPath, expansionRoot, {
    maxEntryBytes: largestEntry,
    maxExpandedBytes: largestPackTotal,
  });
  assert.equal(withinExpansion.ok, true, JSON.stringify(withinExpansion.failures));
}

// ---- CLI behavior ---------------------------------------------------------
{
  // Text mode keeps its human banner.
  const run = runVerifyCli(zipManifest, join(fixtureRoot, zipOut));
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('Delivery verification passed.'));
  assert.ok(run.stdout.includes('mpgd v'));
}
{
  // Machine-readable mode: stdout is exactly one JSON document —
  // JSON.parse runs on the whole stdout, no banner stripping.
  const run = runVerifyCli(zipManifest, join(fixtureRoot, zipOut), '--json');
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as AssetPackVerifyReport;
  assert.equal(parsed.ok, true);
  assert.equal(run.stdout.trim().startsWith('{'), true);
  assert.equal(run.stdout.trim().endsWith('}'), true);
}
{
  // A missing referenced file in JSON mode still prints one parseable
  // report document and exits non-zero.
  const holeRoot = join(fixtureRoot, 'out-hole-cli');
  cpSync(join(fixtureRoot, filesOut), holeRoot, { recursive: true });
  rmSync(join(holeRoot, 'packs', 'grove@1', 'grove.png'));
  const run = runVerifyCli(join(holeRoot, 'asset-pack-delivery.json'), holeRoot, '--json');
  assert.equal(run.status, 1);
  const parsed = JSON.parse(run.stdout) as AssetPackVerifyReport;
  assert.equal(parsed.ok, false);
}
{
  // Framework-level argument errors (rejected before the command handler)
  // keep stdout blank and report on stderr with a non-zero exit.
  const run = runVerifyCli(zipManifest, join(fixtureRoot, zipOut), '--json', '--max-files', 'abc');
  assert.equal(run.status, 1);
  assert.equal(run.stdout.trim().length, 0);
  assert.ok(run.stderr.includes('--max-files'));
}
{
  // --help wins over --json: its own usage text is printed instead.
  const help = runVerifyCli(zipManifest, join(fixtureRoot, zipOut), '--json', '--help');
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--manifest'));
  let helpIsJson = true;
  try {
    JSON.parse(help.stdout);
  } catch {
    helpIsJson = false;
  }
  assert.equal(helpIsJson, false);
}
{
  // --version wins over --json: only the version line is printed.
  const version = spawnSync(
    process.execPath,
    ['tools/run-ttsx.mjs', '--mpgd-cli', 'packages/cli/src/bin.ts', '--version', '--json'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/u);
}
{
  const run = runVerifyCli(
    filesManifest,
    join(fixtureRoot, filesOut),
    '--json',
    '--max-files',
    '1',
  );
  assert.equal(run.status, 1);
  const parsed = JSON.parse(run.stdout) as AssetPackVerifyReport;
  assert.equal(parsed.ok, false);
  assert.ok(parsed.failures.some((failure) => failure.code === 'max-files'));
}
{
  const run = runVerifyCli(zipManifest, join(fixtureRoot, zipOut), '--json', '--max-files', '1.5');
  assert.equal(run.status, 1);
  const parsed = JSON.parse(run.stdout) as AssetPackVerifyReport;
  assert.equal(parsed.ok, false);
  assert.ok(
    parsed.failures.some(
      (failure) => failure.stage === 'args' && failure.code === 'invalid-option',
    ),
  );
}
{
  const run = runVerifyCli(
    zipManifest,
    join(fixtureRoot, zipOut),
    '--json',
    '--max-archive-bytes',
    '1',
  );
  assert.equal(run.status, 1);
  const parsed = JSON.parse(run.stdout) as AssetPackVerifyReport;
  assert.equal(parsed.ok, false);
  assert.ok(parsed.failures.some((failure) => failure.code === 'max-archive-bytes'));
}
{
  // A missing referenced file fails with a non-zero exit.
  const holeRoot = join(fixtureRoot, 'out-hole-cli');
  cpSync(join(fixtureRoot, filesOut), holeRoot, { recursive: true });
  rmSync(join(holeRoot, 'packs', 'grove@1', 'grove.png'));
  const run = runVerifyCli(join(holeRoot, 'asset-pack-delivery.json'), holeRoot, '--json');
  assert.equal(run.status, 1);
  const parsed = JSON.parse(run.stdout) as AssetPackVerifyReport;
  assert.equal(parsed.ok, false);
}

// ---- Inputs unchanged ------------------------------------------------------
for (const [label, dir] of outputDirs) {
  const before = beforeSnapshot.get(label);
  assert.ok(before !== undefined);
  inputsUnchanged(before, snapshotTree(join(fixtureRoot, dir)));
}

console.info(
  'Asset pack verify-delivery checks passed: real build-packs artifacts, referenced integrity, '
    + 'zip interior verification, path/symlink/traversal rejection, host limits with inventory '
    + 'scope, deterministic reports, unchanged inputs, and CLI exit codes with --json output.',
);
