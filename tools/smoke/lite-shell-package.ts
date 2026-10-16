import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveNativeCommandLaunch } from '../../packages/cli/src/command-launcher.js';
import { isObject } from '../validation/json.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = mkdtempSync(join(tmpdir(), 'mpgd-lite-package-'));
const consumer = join(fixture, 'consumer');
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  key.toLowerCase() !== 'npm_config_workspace_dir'
  && !['NODE_OPTIONS', 'MPGD_KIT_PATH', 'TTSC_RUNNER_PROJECT'].includes(key),
));

function run(command: string, args: readonly string[], cwd: string): string {
  const launch = resolveNativeCommandLaunch({ command, args, environment });
  const result = spawnSync(launch.command, [...launch.args], {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

try {
  mkdirSync(consumer);
  run('pnpm', ['pack', '--pack-destination', fixture], join(repoRoot, 'packages/lite-shell'));
  const tarball = readdirSync(fixture).find((file) => file.endsWith('.tgz'));
  assert.ok(tarball);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { '@mpgd/lite-shell': `file:${join(fixture, tarball)}` },
    }),
  );
  // No workspace aliases, compiler loader, registry dependencies, or install scripts.
  // pnpm exec resolves npm.cmd on Windows without passing a shell command string.
  run(
    'pnpm',
    [
      'exec',
      'npm',
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    consumer,
  );
  const manifest: unknown = JSON.parse(
    readFileSync(join(consumer, 'node_modules/@mpgd/lite-shell/package.json'), 'utf8'),
  );
  assert.ok(isObject(manifest));
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.dependencies, undefined);
  assert.match(
    readFileSync(join(consumer, 'node_modules/@mpgd/lite-shell/LICENSE'), 'utf8'),
    /MIT License/,
  );
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import * as shell from '@mpgd/lite-shell';
    for (const name of ['createLiteShell', 'createCanvasRenderer', 'createFrameLoop', 'TapRecognizer', 'loadFontSubset', 'collectGlyphs']) {
      assert.equal(typeof shell[name], 'function', name);
    }
    assert.equal(shell.collectGlyphs('aba', 'c'), 'abc');
    assert.equal(await shell.loadFontSubset({ family: 'Test', url: 'test.woff2' }), false);
  `], consumer);
  writeFileSync(join(consumer, 'usage.mts'), `
    import { createLiteShell, createCanvasRenderer, type LiteShell, type CanvasSurface, type LoadFontSubsetOptions } from '@mpgd/lite-shell';
    const options: LoadFontSubsetOptions = { display: 'swap', onLateLoad: face => { void face.family; } };
    const game: LiteShell<CanvasSurface> = createLiteShell({
      mount: document.createElement('div'), renderer: createCanvasRenderer(),
      frame: ({ context, size }) => { context.clearRect(0, 0, size.width, size.height); return false; },
      onTap: (tap, event) => { void tap.x; void event.pointerId; },
    });
    void options; game.dispose();
  `);
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        types: [],
        skipLibCheck: false,
      },
      files: ['usage.mts'],
    }),
  );
  run('pnpm', ['exec', 'ttsc', '-p', join(consumer, 'tsconfig.json')], repoRoot);

  // pnpm rewrites workspace devDependencies in the published CLI manifest.
  // This is the version source used without any adjacent Kit checkout.
  const cliPacks = join(fixture, 'cli');
  mkdirSync(cliPacks);
  run('pnpm', ['pack', '--pack-destination', cliPacks], join(repoRoot, 'packages/cli'));
  const cliTarball = readdirSync(cliPacks).find((file) => file.endsWith('.tgz'));
  assert.ok(cliTarball);
  const packedCli: unknown = JSON.parse(
    run('tar', ['-xOf', join(cliPacks, cliTarball), 'package/package.json'], fixture),
  );
  assert.ok(isObject(packedCli) && isObject(packedCli.devDependencies));
  assert.equal(packedCli.devDependencies['@mpgd/lite-shell'], manifest.version);
  console.info(
    'Lite shell packed ESM, strict NodeNext declarations and CLI version metadata passed.',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
