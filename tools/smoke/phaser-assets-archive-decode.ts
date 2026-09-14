import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildAssetPacks } from '../../packages/cli/src/asset-pack-build';
import type {
  ArchiveWorkerRequest,
  ArchiveWorkerResponse,
} from '../../packages/phaser-assets/src/archive-protocol';
import { createArchiveWorkerDispatch } from '../../packages/phaser-assets/src/archive-worker-impl';
import { decodeZipV1Entries } from '../../packages/phaser-assets/src/archive-zip-core';
import {
  createBoundedZipDecoder,
  type ZipDecodeWorkerLike,
} from '../../packages/phaser-assets/src/archives';

const repoRoot = resolve('.');
const fixtureRoot = join('node_modules', '.cache', 'mpgd-phaser-assets-archive-decode');
const sourceRoot = join(fixtureRoot, 'src');
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
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
const texture = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  incompressible(2048, 7),
]);
const atlasJson = Buffer.from(
  `${JSON.stringify({
    frames: Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`frame${index}`, { frame: { x: index * 8, y: 0, w: 8, h: 8 } }]),
    ),
  })}\n`,
  'utf8',
);

/** In-process worker driving the real dispatch logic. */
function createInProcessWorker(): ZipDecodeWorkerLike & { terminated: boolean } {
  const messageListeners: ((event: MessageEvent<ArchiveWorkerResponse>) => void)[] = [];
  const errorListeners: ((event: Event) => void)[] = [];
  const state = { terminated: false };
  const dispatch = createArchiveWorkerDispatch({
    post: (message): void => {
      if (state.terminated) {
        return;
      }
      for (const listener of [...messageListeners]) {
        listener({ data: message } as MessageEvent<ArchiveWorkerResponse>);
      }
    },
  });
  return {
    terminated: state.terminated,
    postMessage(message: ArchiveWorkerRequest): void {
      if (state.terminated) {
        return;
      }
      dispatch(message);
    },
    addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: never) => void): void {
      if (type === 'message') {
        messageListeners.push(listener as (event: MessageEvent<ArchiveWorkerResponse>) => void);
      } else {
        errorListeners.push(listener as (event: Event) => void);
      }
    },
    terminate(): void {
      state.terminated = true;
    },
  };
}

try {
  rmSync(fixtureRoot, { force: true, recursive: true });
  mkdirSync(join(sourceRoot, 'grove'), { recursive: true });
  writeFileSync(join(sourceRoot, 'grove/grove.png'), texture);
  writeFileSync(join(sourceRoot, 'grove/grove.json'), atlasJson);
  const configPath = join(fixtureRoot, 'packs.config.json');
  writeJson(configPath, {
    root: 'src',
    packs: [{
      id: 'grove', revision: '3', delivery: 'zip', assets: [{
        kind: 'atlas', key: 'ground', texture: 'grove/grove.png', atlas: 'grove/grove.json',
      }],
    }],
  });

  // 1. Build with the PR2 CLI builder and decode with the pure core.
  const outDir = join(fixtureRoot, 'out');
  const report = buildAssetPacks({ configPath, outDir, cwd: repoRoot });
  assert.equal(report.archives.length, 1);
  const archivePath = join(outDir, report.archives[0]!.path);
  const archive = new Uint8Array(readFileSync(archivePath));
  const manifest = JSON.parse(readFileSync(join(outDir, 'asset-pack-delivery.json'), 'utf8'));
  const zipPack = manifest.packs[0]!;
  const expected = {
    formatVersion: manifest.version,
    archive: {
      bytes: zipPack.archive.bytes,
      sha256: zipPack.archive.sha256,
    },
    entries: zipPack.assets[0]!.files.map((file: { path: string; method: 'store' | 'deflate'; bytes: number; sha256: string }) => ({
      path: file.path,
      method: file.method,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  };
  const coreOutput: { path: string; bytes: Uint8Array }[] = [];
  for await (const entry of decodeZipV1Entries(archive, expected, {
    archiveBytes: 1024 * 1024,
    entryBytes: 1024 * 1024,
    totalExpandedBytes: 4 * 1024 * 1024,
    entryCount: 64,
    maxPathLength: 256,
    decodeDeadlineMs: 5000,
  })) {
    coreOutput.push({ path: entry.path, bytes: entry.bytes });
  }
  assert.deepEqual(
    coreOutput.map((entry) => entry.path),
    ['grove/grove.png', 'grove/grove.json'],
  );
  assert.ok(
    Buffer.from(coreOutput[0]!.bytes).equals(texture),
    'PR2 texture round-trips through the core',
  );
  assert.ok(
    Buffer.from(coreOutput[1]!.bytes).equals(atlasJson),
    'PR2 atlas JSON round-trips through the core',
  );
  assert.equal(sha256(coreOutput[0]!.bytes), expected.entries[0].sha256);

  // 2. The same archive decodes through the client and the worker protocol.
  const decoder = createBoundedZipDecoder({ createWorker: createInProcessWorker });
  const job = decoder.decode({ archive, expected });
  const clientOutput: { path: string; bytes: Uint8Array }[] = [];
  for await (const entry of job.entries) {
    clientOutput.push({ path: entry.path, bytes: entry.bytes });
  }
  const status = await job.result;
  assert.equal(status.status, 'completed');
  assert.ok(
    Buffer.from(clientOutput[1]!.bytes).equals(atlasJson),
    'PR2 atlas JSON round-trips through the worker protocol',
  );
  assert.equal(status.stats?.entries, 2);

  // 3. The published tarball carries the new subpaths and worker entry.
  if (!existsSync(join(repoRoot, 'packages/phaser-assets/dist/archives.js'))) {
    throw new Error('Missing packages/phaser-assets/dist; run pnpm build:packages first');
  }
  const packDestination = resolve(repoRoot, fixtureRoot, 'packed');
  mkdirSync(packDestination, { recursive: true });
  const packed = spawnSync('pnpm', ['pack', '--silent', '--pack-destination', packDestination], {
    cwd: join(repoRoot, 'packages/phaser-assets'),
    encoding: 'utf8',
  });
  assert.equal(packed.status, 0, `pnpm pack failed: ${packed.stderr}`);
  const [tarball] = readdirSync(packDestination).filter((name) => name.endsWith('.tgz'));
  assert.ok(tarball !== undefined, 'expected exactly one packed tarball');
  const tarballPath = join(packDestination, tarball);
  const listing = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' });
  assert.equal(listing.status, 0, `tar listing failed: ${listing.stderr}`);
  const names = listing.stdout.trim().split('\n');
  for (const required of [
    'package/dist/archives.js',
    'package/dist/archive-worker.js',
    'package/dist/archive-zip-core.js',
  ]) {
    assert.ok(names.includes(required), `tarball includes ${required}`);
  }
  const packageJson = spawnSync('tar', ['-xOf', tarballPath, 'package/package.json'], {
    encoding: 'utf8',
  });
  assert.match(packageJson.stdout, /"fflate": "0\.8\.3"/u, 'published package pins fflate');

  console.info(
    'Bounded ZIP decode checks passed: PR2 artifact round-trip through the core and the worker protocol, and packaged subpath/worker presence in the tarball.',
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}
