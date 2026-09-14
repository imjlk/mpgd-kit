import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

import { buildAssetPacks } from '../../packages/cli/src/asset-pack-build';

const repoRoot = resolve('.');
const fixtureRoot = join('node_modules', '.cache', 'mpgd-cli-asset-pack-build');
const sourceRoot = join(fixtureRoot, 'src');
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** Deterministic pseudo-random payload that DEFLATE cannot shrink. */
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
  incompressible(300, 11),
]);
const grovePng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  incompressible(4096, 22),
]);
const groveJson = Buffer.from(
  `${JSON.stringify({
    frames: Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`frame${index}`, {
        frame: { x: index * 16, y: 0, w: 16, h: 16 }, rotated: false, trimmed: false,
      }]),
    ),
  })}\n`,
  'utf8',
);
const dunesPng = incompressible(64, 33);
const tinyJson = incompressible(24, 44);

const basePacks = [
  {
    id: 'shared', revision: '1', delivery: 'files', assets: [{
      kind: 'spritesheet', key: 'pilot', file: 'shared/pilot.png', frameConfig: {
        frameWidth: 64, frameHeight: 64, spacing: 1,
      },
    }],
  },
  {
    id: 'grove', revision: '3', dependsOn: ['shared'], delivery: 'zip', assets: [{
      kind: 'atlas', key: 'ground', texture: 'grove/grove.png', atlas: 'grove/grove.json',
    }],
  },
  {
    id: 'dunes', revision: '1', dependsOn: ['shared'], delivery: 'files', assets: [{
      kind: 'image', key: 'ground', file: 'dunes/dunes.png',
    }],
  },
];

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  versionMadeBy: number;
  flags: number;
  time: number;
  date: number;
  externalAttributes: number;
  extraLength: number;
  commentLength: number;
  data: Buffer;
}

/** Minimal independent ZIP reader for round-trip verification. */
function readZipEntries(archive: Buffer): ZipEntry[] {
  assert.ok(archive.length >= 22, 'archive has an end record');
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, 'end of central directory signature');
  const totalEntries = archive.readUInt16LE(end + 10);
  const centralDirectoryOffset = archive.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < totalEntries; index++) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, 'central directory signature');
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    assert.equal(
      archive.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength),
      name,
      'local name matches',
    );
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const method = archive.readUInt16LE(cursor + 10);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    entries.push({
      name,
      method,
      crc: archive.readUInt32LE(cursor + 16),
      compressedSize,
      uncompressedSize: archive.readUInt32LE(cursor + 24),
      versionMadeBy: archive.readUInt16LE(cursor + 4),
      flags: archive.readUInt16LE(cursor + 8),
      time: archive.readUInt16LE(cursor + 12),
      date: archive.readUInt16LE(cursor + 14),
      externalAttributes: archive.readUInt32LE(cursor + 38),
      extraLength,
      commentLength,
      data: method === 8 ? inflateRawSync(stored) : Buffer.from(stored),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(
    cursor,
    archive.readUInt32LE(end + 12) + centralDirectoryOffset,
    'central directory consumed exactly',
  );
  return entries;
}

const runBuildCli = (config: string, out: string): SpawnSyncReturns<string> => spawnSync(
  process.execPath,
  [
    'tools/run-ttsx.mjs',
    '--mpgd-cli',
    'packages/cli/src/bin.ts',
    'assets',
    'build-packs',
    '--config',
    config,
    '--out',
    out,
  ],
  { cwd: repoRoot, encoding: 'utf8', timeout: 60_000 },
);

function outputTree(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        files.set(path, readFileSync(path));
      }
    }
  };
  walk(root);
  return files;
}

function assertSameTree(
  actualRoot: string,
  actual: Map<string, Buffer>,
  expectedRoot: string,
  expected: Map<string, Buffer>,
  label: string,
): void {
  const relativeKeys = (root: string, tree: Map<string, Buffer>): string[] => [...tree.keys()]
    .map((path) => path.slice(root.length + 1))
    .sort();
  assert.deepEqual(
    relativeKeys(actualRoot, actual),
    relativeKeys(expectedRoot, expected),
    `${label}: same files`,
  );
  for (const [path, data] of expected) {
    assert.ok(
      actual.get(join(actualRoot, path.slice(expectedRoot.length + 1)))!.equals(data),
      `${label}: byte-identical ${path.slice(expectedRoot.length + 1)}`,
    );
  }
}

try {
  rmSync(fixtureRoot, { force: true, recursive: true });
  mkdirSync(join(sourceRoot, 'shared'), { recursive: true });
  mkdirSync(join(sourceRoot, 'grove'), { recursive: true });
  mkdirSync(join(sourceRoot, 'dunes'), { recursive: true });
  mkdirSync(join(sourceRoot, 'tiny'), { recursive: true });
  writeFileSync(join(sourceRoot, 'shared/pilot.png'), pilotPng);
  writeFileSync(join(sourceRoot, 'grove/grove.png'), grovePng);
  writeFileSync(join(sourceRoot, 'grove/grove.json'), groveJson);
  writeFileSync(join(sourceRoot, 'dunes/dunes.png'), dunesPng);
  writeFileSync(join(sourceRoot, 'tiny/tiny.json'), tinyJson);
  const mainConfig = join(fixtureRoot, 'packs.config.json');
  writeJson(mainConfig, { root: 'src', packs: basePacks });

  // 1. A first build writes every artifact and the external manifest.
  const firstOut = join(fixtureRoot, 'out-first');
  const first = runBuildCli(mainConfig, firstOut);
  assert.equal(first.status, 0, `first build stdout: ${first.stdout}\nstderr: ${first.stderr}`);
  assert.match(first.stdout, /wrote asset-pack-delivery\.json/u);
  assert.match(first.stdout, /archive packs\/grove@3\.zip: 2 entries \(1 store, 1 deflate\)/u);
  const firstTree = outputTree(firstOut);
  assert.deepEqual(
    [...firstTree.keys()].sort().map((path) => path.slice(firstOut.length + 1)),
    [
      'asset-pack-delivery.json',
      'packs/dunes@1/dunes/dunes.png',
      'packs/grove@3.zip',
      'packs/shared@1/shared/pilot.png',
    ],
    'exactly the configured outputs, dependencies not duplicated',
  );
  const manifest = JSON.parse(
    firstTree.get(join(firstOut, 'asset-pack-delivery.json'))!.toString('utf8'),
  );
  assert.equal(manifest.format, 'mpgd-asset-packs');
  assert.equal(manifest.version, 1);
  assert.deepEqual(
    manifest.packs.map((pack: { packId: string }) => pack.packId),
    ['shared', 'grove', 'dunes'],
  );
  const shared = manifest.packs[0]!;
  assert.equal(shared.assets[0]!.kind, 'spritesheet');
  assert.deepEqual(shared.assets[0]!.frameConfig, { frameWidth: 64, frameHeight: 64, spacing: 1 });
  assert.equal(shared.assets[0]!.files[0]!.path, 'packs/shared@1/shared/pilot.png');
  assert.equal(shared.assets[0]!.files[0]!.bytes, pilotPng.length);
  assert.equal(shared.assets[0]!.files[0]!.sha256, sha256(pilotPng));
  assert.equal(shared.assets[0]!.files[0]!.mediaType, 'image/png');
  const grove = manifest.packs[1]!;
  assert.deepEqual(grove.dependencies, [{ packId: 'shared', revision: '1' }]);
  assert.deepEqual(
    grove.assets[0]!.files.map((file: { role: string }) => file.role),
    ['texture', 'atlas'],
  );
  assert.equal(grove.assets[0]!.files[0]!.path, 'grove/grove.png');
  assert.equal(grove.assets[0]!.files[0]!.method, 'store');
  assert.equal(grove.assets[0]!.files[1]!.path, 'grove/grove.json');
  assert.equal(grove.assets[0]!.files[1]!.method, 'deflate');
  const archive = firstTree.get(join(firstOut, 'packs/grove@3.zip'))!;
  assert.equal(grove.archive!.bytes, archive.length);
  assert.equal(grove.archive!.sha256, sha256(archive));
  assert.equal(grove.archive!.entryCount, 2);

  // 2. ZIP round-trip: mixed STORE/DEFLATE, fixed metadata, exact entry bytes.
  const entries = readZipEntries(archive);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['grove/grove.png', 'grove/grove.json'],
  );
  for (const entry of entries) {
    assert.equal(entry.versionMadeBy, 0x0300, 'fixed version made by');
    assert.equal(entry.flags, 0x0800, 'UTF-8 flag only');
    assert.equal(entry.time, 0, 'fixed DOS time');
    assert.equal(entry.date, 0x0021, 'fixed DOS date 1980-01-01');
    assert.equal(entry.externalAttributes >>> 16, 0o100644, 'fixed regular-file permissions');
    assert.equal(entry.extraLength, 0, 'no extra fields');
    assert.equal(entry.commentLength, 0, 'no comments');
    assert.equal(crc32(entry.data) >>> 0, entry.crc, 'CRC-32 matches inflated bytes');
  }
  assert.ok(entries[0]!.method === 0 && entries[0]!.data.equals(grovePng), 'PNG stored verbatim');
  assert.ok(
    entries[1]!.method === 8 && entries[1]!.data.equals(groveJson),
    'JSON deflated round-trips',
  );
  assert.ok(
    entries[1]!.compressedSize < entries[1]!.uncompressedSize,
    'deflate actually shrinks the JSON',
  );

  // 3. Same sources delivered as files and as a zip carry identical bytes.
  const zipSharedConfig = join(fixtureRoot, 'zip-shared.config.json');
  writeJson(zipSharedConfig, {
    root: 'src',
    packs: [{
      id: 'shared', revision: '1', delivery: 'zip', assets: [{
        kind: 'spritesheet', key: 'pilot', file: 'shared/pilot.png', frameConfig: {
          frameWidth: 64, frameHeight: 64,
        },
      }],
    }],
  });
  const zipSharedOut = join(fixtureRoot, 'out-zip-shared');
  assert.equal(runBuildCli(zipSharedConfig, zipSharedOut).status, 0);
  const zipShared = readZipEntries(readFileSync(join(zipSharedOut, 'packs/shared@1.zip')));
  assert.ok(
    zipShared[0]!.data.equals(firstTree.get(join(firstOut, 'packs/shared@1/shared/pilot.png'))!),
  );
  assert.ok(zipShared[0]!.data.equals(pilotPng));

  // 4. Compression policy: explicit override forces, default falls back to STORE
  //    when DEFLATE does not shrink the entry.
  const tinyConfig = join(fixtureRoot, 'tiny.config.json');
  writeJson(tinyConfig, {
    root: 'src',
    packs: [
      {
        id: 'tiny-forced', revision: '1', delivery: 'zip', assets: [{
          kind: 'image', key: 'blob', file: 'tiny/tiny.json', compression: 'deflate',
        }],
      },
      {
        id: 'tiny-auto', revision: '1', delivery: 'zip', assets: [{
          kind: 'image', key: 'blob', file: 'tiny/tiny.json',
        }],
      },
    ],
  });
  const tinyOut = join(fixtureRoot, 'out-tiny');
  assert.equal(runBuildCli(tinyConfig, tinyOut).status, 0);
  const tinyManifest = JSON.parse(readFileSync(join(tinyOut, 'asset-pack-delivery.json'), 'utf8'));
  assert.equal(
    tinyManifest.packs.find((pack: { packId: string }) => pack.packId === 'tiny-forced')!.assets[0]!.files[0]!.method,
    'deflate',
    'explicit override forces deflate even when it does not shrink',
  );
  assert.equal(
    tinyManifest.packs.find((pack: { packId: string }) => pack.packId === 'tiny-auto')!.assets[0]!.files[0]!.method,
    'store',
    'default policy falls back to store for incompressible entries',
  );

  // 5. Determinism: fresh builds are byte-identical; mtimes do not matter.
  const secondOut = join(fixtureRoot, 'out-second');
  assert.equal(runBuildCli(mainConfig, secondOut).status, 0);
  assertSameTree(secondOut, outputTree(secondOut), firstOut, firstTree, 'fresh rebuild');
  const later = new Date(Date.now() + 3_600_000);
  for (const file of ['shared/pilot.png', 'grove/grove.png', 'grove/grove.json']) {
    utimesSync(join(sourceRoot, file), later, later);
  }
  const thirdOut = join(fixtureRoot, 'out-third');
  assert.equal(runBuildCli(mainConfig, thirdOut).status, 0);
  assert.ok(
    readFileSync(join(thirdOut, 'packs/grove@3.zip')).equals(archive),
    'mtime changes do not alter the archive',
  );
  assert.ok(
    readFileSync(join(thirdOut, 'asset-pack-delivery.json')).equals(
      firstTree.get(join(firstOut, 'asset-pack-delivery.json'))!,
    ),
    'mtime changes do not alter the manifest',
  );

  // 6. Rebuilding into the same output is idempotent.
  const rebuild = runBuildCli(mainConfig, firstOut);
  assert.equal(rebuild.status, 0);
  assert.match(rebuild.stdout, /unchanged asset-pack-delivery\.json/u);
  assertSameTree(firstOut, outputTree(firstOut), firstOut, firstTree, 'idempotent rebuild');

  // 7. Content changes move digests; revisions move artifact paths.
  const changedGrove = Buffer.concat([grovePng, Buffer.from([1, 2, 3])]);
  writeFileSync(join(sourceRoot, 'grove/grove.png'), changedGrove);
  const bumpedConfig = join(fixtureRoot, 'bumped.config.json');
  writeJson(bumpedConfig, {
    root: 'src',
    packs: basePacks.map((pack) => pack.id === 'grove' ? { ...pack, revision: '4' } : pack),
  });
  const bumped = runBuildCli(bumpedConfig, firstOut);
  assert.equal(bumped.status, 0, `bumped build failed: ${bumped.stderr}`);
  const bumpedManifest = JSON.parse(
    readFileSync(join(firstOut, 'asset-pack-delivery.json'), 'utf8'),
  );
  const bumpedGrove = bumpedManifest.packs.find(
    (pack: { packId: string }) => pack.packId === 'grove',
  )!;
  assert.equal(bumpedGrove.revision, '4');
  assert.equal(bumpedGrove.archive!.path, 'packs/grove@4.zip');
  assert.notEqual(bumpedGrove.archive!.sha256, grove.archive!.sha256);
  assert.notEqual(bumpedGrove.assets[0]!.files[0]!.sha256, grove.assets[0]!.files[0]!.sha256);
  assert.equal(bumpedGrove.assets[0]!.files[0]!.sha256, sha256(changedGrove));
  assert.ok(existsSync(join(firstOut, 'packs/grove@4.zip')), 'new revision artifact exists');
  assert.ok(existsSync(join(firstOut, 'packs/grove@3.zip')), 'previous revision artifact is kept');

  // 8. Changed bytes under the same revision are an immutable conflict, and a
  //    failing build leaves the previous successful outputs untouched.
  const beforeConflict = outputTree(firstOut);
  const conflict = runBuildCli(mainConfig, firstOut);
  assert.notEqual(conflict.status, 0, 'conflicting rebuild must fail');
  assert.match(conflict.stderr, /immutable conflict/u);
  assertSameTree(firstOut, outputTree(firstOut), firstOut, beforeConflict, 'failed build');
  rmSync(join(sourceRoot, 'grove/grove.json'), { force: true });
  assert.throws(
    () => buildAssetPacks({ configPath: mainConfig, outDir: firstOut, cwd: repoRoot }),
    /Missing pack source file: grove\/grove\.json/u,
  );
  assertSameTree(firstOut, outputTree(firstOut), firstOut, beforeConflict, 'missing source');
  writeFileSync(join(sourceRoot, 'grove/grove.json'), groveJson);

  // 9. Input and output path rules are enforced end to end.
  const badCases: { name: string; config: unknown; outDir?: string; message: RegExp }[] = [
    {
      name: 'output inside source root',
      config: {
        root: 'src', packs: basePacks,
      },
      outDir: join(sourceRoot, 'inside-out'),
      message: /outside the pack source root/u,
    },
    {
      name: 'unsupported extension', config: {
        root: 'src',
        packs: [{
          id: 'x', revision: '1', delivery: 'files', assets: [{
            kind: 'image', key: 'k', file: 'shared/pilot.gif',
          }],
        }],
      }, message: /Unsupported pack source extension/u,
    },
    {
      name: 'escaping path', config: {
        root: 'src',
        packs: [{
          id: 'x', revision: '1', delivery: 'files', assets: [{
            kind: 'image', key: 'k', file: '../pilot.png',
          }],
        }],
      }, message: /Invalid/u,
    },
    {
      name: 'duplicate entry path', config: {
        root: 'src',
        packs: [{
          id: 'x', revision: '1', delivery: 'files', assets: [
            { kind: 'image', key: 'a', file: 'shared/pilot.png' },
            { kind: 'image', key: 'b', file: 'shared/pilot.png' },
          ],
        }],
      }, message: /duplicate file/u,
    },
    {
      name: 'unsupported compression', config: {
        root: 'src',
        packs: [{
          id: 'x', revision: '1', delivery: 'files', assets: [{
            kind: 'image', key: 'k', file: 'shared/pilot.png', compression: 'brotli',
          }],
        }],
      }, message: /Invalid/u,
    },
    {
      name: 'zip delivery without assets', config: {
        root: 'src',
        packs: [{ id: 'x', revision: '1', delivery: 'zip', assets: [] }],
      }, message: /zip delivery requires at least one asset/u,
    },
    {
      name: 'unknown dependency', config: {
        root: 'src',
        packs: [{
          id: 'x', revision: '1', dependsOn: ['nope'], delivery: 'files', assets: [{
            kind: 'image', key: 'k', file: 'shared/pilot.png',
          }],
        }],
      }, message: /unknown dependency/u,
    },
  ];
  for (const { name, config, outDir, message } of badCases) {
    const configPath = join(fixtureRoot, 'bad.config.json');
    writeJson(configPath, config);
    assert.throws(
      () => buildAssetPacks({
        configPath,
        outDir: outDir ?? join(fixtureRoot, 'out-bad'),
        cwd: repoRoot,
      }),
      message,
      name,
    );
  }
  const rootEqualsOutConfig = join(fixtureRoot, 'root-equals-out.config.json');
  writeJson(rootEqualsOutConfig, { root: 'src', packs: basePacks });
  assert.throws(
    () => buildAssetPacks({
      configPath: rootEqualsOutConfig,
      outDir: sourceRoot,
      cwd: repoRoot,
    }),
    /outside the pack source root/u,
    'output equal to the source root is rejected',
  );

  // 10. Symlinked sources are rejected.
  const outsideTarget = join(fixtureRoot, 'outside.png');
  writeFileSync(outsideTarget, pilotPng);
  const linkPath = join(sourceRoot, 'shared/link.png');
  try {
    symlinkSync(resolve(repoRoot, outsideTarget), linkPath);
  } catch {
    chmodSync(sourceRoot, 0o755);
    symlinkSync(resolve(repoRoot, outsideTarget), linkPath);
  }
  const symlinkConfig = join(fixtureRoot, 'symlink.config.json');
  writeJson(symlinkConfig, {
    root: 'src',
    packs: [{
      id: 'x', revision: '1', delivery: 'files', assets: [{
        kind: 'image', key: 'k', file: 'shared/link.png',
      }],
    }],
  });
  assert.throws(
    () => buildAssetPacks({
      configPath: symlinkConfig,
      outDir: join(fixtureRoot, 'out-symlink'),
      cwd: repoRoot,
    }),
    /must not contain symbolic links/u,
  );
  rmSync(linkPath, { force: true });

  // 10b. Empty source files and symlinked output paths are rejected.
  writeFileSync(join(sourceRoot, 'shared/empty.png'), Buffer.alloc(0));
  const emptyConfig = join(fixtureRoot, 'empty.config.json');
  writeJson(emptyConfig, {
    root: 'src',
    packs: [{
      id: 'x', revision: '1', delivery: 'files', assets: [{
        kind: 'image', key: 'k', file: 'shared/empty.png',
      }],
    }],
  });
  assert.throws(
    () => buildAssetPacks({
      configPath: emptyConfig,
      outDir: join(fixtureRoot, 'out-empty'),
      cwd: repoRoot,
    }),
    /Pack source file is empty/u,
  );
  const outLink = join(fixtureRoot, 'out-link');
  symlinkSync(resolve(repoRoot, sourceRoot), resolve(repoRoot, outLink));
  assert.throws(
    () => buildAssetPacks({ configPath: mainConfig, outDir: outLink, cwd: repoRoot }),
    /outside the pack source root/u,
    'a symlinked output path into the source root is rejected',
  );
  rmSync(outLink, { force: true, recursive: true });

  // 10c. Case-colliding ids and paths fail validation.
  const caseConfig = join(fixtureRoot, 'case.config.json');
  writeJson(caseConfig, {
    root: 'src',
    packs: [
      {
        id: 'Ui', revision: '1', delivery: 'files', assets: [{
          kind: 'image', key: 'k', file: 'shared/pilot.png',
        }],
      },
      {
        id: 'UI', revision: '1', delivery: 'files', assets: [{
          kind: 'image', key: 'k', file: 'dunes/dunes.png',
        }],
      },
    ],
  });
  assert.throws(
    () => buildAssetPacks({
      configPath: caseConfig,
      outDir: join(fixtureRoot, 'out-case'),
      cwd: repoRoot,
    }),
    /case-colliding pack id/u,
  );
  const casePathConfig = join(fixtureRoot, 'case-path.config.json');
  writeJson(casePathConfig, {
    root: 'src',
    packs: [{
      id: 'mixed', revision: '1', delivery: 'files', assets: [
        { kind: 'image', key: 'upper', file: 'shared/Pilot.png' },
        { kind: 'image', key: 'lower', file: 'shared/pilot.png' },
      ],
    }],
  });
  assert.throws(
    () => buildAssetPacks({
      configPath: casePathConfig,
      outDir: join(fixtureRoot, 'out-case-path'),
      cwd: repoRoot,
    }),
    /case-colliding file/u,
  );

  // 11. The packaged CLI builds packs outside the kit checkout. The tarballs
  //     carry the built dist, so run pnpm build:packages before this smoke.
  const packDestination = resolve(repoRoot, fixtureRoot, 'packed');
  mkdirSync(packDestination, { recursive: true });
  const packWorkspace = (directory: string): string => {
    if (!existsSync(join(repoRoot, directory, 'dist', 'index.js'))) {
      throw new Error(`Missing ${directory}/dist; run pnpm build:packages first`);
    }
    const before = new Set(readdirSync(packDestination));
    const packed = spawnSync('pnpm', ['pack', '--silent', '--pack-destination', packDestination], {
      cwd: join(repoRoot, directory),
      encoding: 'utf8',
    });
    assert.equal(packed.status, 0, `pnpm pack failed for ${directory}: ${packed.stderr}`);
    const added = readdirSync(packDestination).filter(
      (name) => !before.has(name) && name.endsWith('.tgz'),
    );
    assert.equal(added.length, 1, `expected exactly one new tarball for ${directory}`);
    return join(packDestination, added[0]!);
  };
  const cliTarball = packWorkspace('packages/cli');
  const assetsTarball = packWorkspace('packages/phaser-assets');
  const consumerRoot = resolve(fixtureRoot, 'packed-consumer');
  mkdirSync(join(consumerRoot, 'src'), { recursive: true });
  writeFileSync(
    join(consumerRoot, 'package.json'),
    '{"name":"packed-consumer","version":"0.0.0","private":true}\n',
  );
  writeFileSync(join(consumerRoot, 'src/pilot.png'), pilotPng);
  writeJson(join(consumerRoot, 'packs.config.json'), {
    root: 'src',
    packs: [{
      id: 'pilot', revision: '1', delivery: 'zip', assets: [{
        kind: 'spritesheet', key: 'pilot', file: 'pilot.png', frameConfig: {
          frameWidth: 64, frameHeight: 64,
        },
      }],
    }],
  });
  const installed = spawnSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--legacy-peer-deps', cliTarball, assetsTarball],
    { cwd: consumerRoot, encoding: 'utf8', timeout: 180_000 },
  );
  assert.equal(installed.status, 0, `packed install failed: ${installed.stderr}`);
  const packedRun = spawnSync(
    process.execPath,
    [
      join(consumerRoot, 'node_modules', '@mpgd', 'cli', 'dist', 'bin.js'),
      'assets',
      'build-packs',
      '--config',
      'packs.config.json',
      '--out',
      'out',
    ],
    { cwd: consumerRoot, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(
    packedRun.status,
    0,
    `packed CLI build failed: ${packedRun.stdout}\n${packedRun.stderr}`,
  );
  const packedManifest = JSON.parse(
    readFileSync(join(consumerRoot, 'out', 'asset-pack-delivery.json'), 'utf8'),
  );
  assert.equal(packedManifest.packs[0]!.archive!.entryCount, 1);
  const packedZip = readZipEntries(readFileSync(join(consumerRoot, 'out', 'packs', 'pilot@1.zip')));
  assert.ok(packedZip[0]!.data.equals(pilotPng), 'packed CLI archive round-trips');

  console.info(
    'Asset pack build CLI checks passed: determinism, idempotence, mtime independence, files/zip parity, STORE/DEFLATE round-trip, revision and digest movement, immutable conflicts, failure preservation, input/output rejections and packaged off-kit execution.',
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}
