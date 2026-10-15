import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertDevvitOutputNames,
  assertNoDevvitOutputCollisions,
  devvitOutputCollisionPlugin,
  findDevvitOutputCollisions,
} from './devvit-output-collisions';

// These logical names must be rejected even on Windows, before writing.
assert.throws(
  () => assertDevvitOutputNames(['game.js', 'Game.js'], [], 'dist'),
  /names differ only by case/u,
);
assert.throws(
  () => assertDevvitOutputNames(['Game.js'], ['game.js'], 'dist'),
  /names differ only by case/u,
);
assert.throws(
  () => assertDevvitOutputNames(['game.js'], ['game.js'], 'dist'),
  /conflicting file name/u,
);
assertDevvitOutputNames(['game.js'], ['font.woff2'], 'dist');

const root = mkdtempSync(join(tmpdir(), 'mpgd-devvit-collisions-'));
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const publicDir = join(root, 'public');
  const outDir = join(root, 'dist/client');
  mkdirSync(join(publicDir, 'fonts'), { recursive: true });
  mkdirSync(join(outDir, 'fonts'), { recursive: true });

  // Copied verbatim: not a collision.
  writeFileSync(join(publicDir, 'fonts/a.woff2'), 'font');
  writeFileSync(join(outDir, 'fonts/a.woff2'), 'font');
  writeFileSync(join(outDir, 'game.js'), 'bundle');
  // A symlinked public directory is traversed, not read as a file.
  mkdirSync(join(root, 'shared'));
  writeFileSync(join(root, 'shared/b.txt'), 'b');
  symlinkSync(join(root, 'shared'), join(publicDir, 'linked'), 'junction');
  mkdirSync(join(outDir, 'linked'));
  writeFileSync(join(outDir, 'linked/b.txt'), 'b');
  assert.deepEqual(findDevvitOutputCollisions(outDir, [publicDir]), []);
  assertNoDevvitOutputCollisions(outDir, [publicDir, join(root, 'missing')]);

  // A public file replaced by a bundle file of the same name.
  writeFileSync(join(publicDir, 'game.js'), '// public');
  const overwritten = findDevvitOutputCollisions(outDir, [publicDir]);
  assert.equal(overwritten.length, 1);
  assert.equal(overwritten[0]?.kind, 'public');
  assert.equal(overwritten[0]?.path, 'game.js');

  // Names that differ only by case (visible only on case-sensitive filesystems).
  writeFileSync(join(outDir, 'Game.JS'), 'other');
  const all = findDevvitOutputCollisions(outDir, [publicDir]);
  const caseSensitive = all.some((collision) => collision.kind === 'case');
  assert.deepEqual(
    all.map((collision) => collision.kind).sort(),
    caseSensitive ? ['case', 'public'] : ['public'],
  );
  assert.throws(
    () => assertNoDevvitOutputCollisions(outDir, [publicDir]),
    /conflicting file name\(s\)[\s\S]*game\.js/u,
  );

  assert.deepEqual(findDevvitOutputCollisions(join(root, 'nope'), [publicDir]), []);

  const cleanPlugin = join(root, 'clean-kit/packages/cli/src/devvit-output-collisions.ts');
  mkdirSync(join(root, 'clean-kit/packages/cli/src'), { recursive: true });
  copyFileSync(resolve('packages/cli/src/devvit-output-collisions.ts'), cleanPlugin);
  assert.equal(existsSync(join(root, 'clean-kit/packages/cli/dist')), false);

  // Exercise the actual pre-write hook with the kit's Vite 8 and Devvit's
  // Vite 7. Explicit emitted names must survive until the hook on Windows.
  for (const packageFile of ['package.json', 'apps/target-devvit/package.json']) {
    const wrapperRequire = createRequire(resolve(packageFile));
    const { createBuilder }: typeof import('vite') = await import(
      pathToFileURL(wrapperRequire.resolve('vite')).href
    );
    const buildRoot = join(root, packageFile.startsWith('apps') ? 'vite7' : 'vite8');
    const buildOut = join(buildRoot, 'dist');
    const customPublic = join(buildRoot, 'custom-public');
    mkdirSync(customPublic, { recursive: true });
    writeFileSync(join(buildRoot, 'entry.js'), 'console.log("fixture");');
    writeFileSync(join(customPublic, 'main.js'), 'public');
    const build = async (caseCollision: boolean, copyPublicDir: boolean): Promise<void> => {
      const builder = await createBuilder(
        {
          configFile: false,
          root: buildRoot,
          publicDir: customPublic,
          logLevel: 'silent',
          plugins: [
            {
              name: 'collision-fixture',
              generateBundle() {
                if (caseCollision) {
                  this.emitFile({ type: 'asset', fileName: 'Case.js', source: 'first' });
                  this.emitFile({ type: 'asset', fileName: 'case.js', source: 'second' });
                }
              },
            },
            devvitOutputCollisionPlugin(),
          ],
          build: {
            outDir: buildOut,
            copyPublicDir,
            rollupOptions: {
              input: join(buildRoot, 'entry.js'),
              output: { entryFileNames: 'main.js' },
            },
          },
        },
        null,
      );
      await builder.buildApp();
    };
    await assert.rejects(build(true, false), /names differ only by case/u);
    assert.equal(existsSync(join(buildOut, 'Case.js')), false);
    await assert.rejects(build(false, true), /public and bundle files use the same output name/u);
    // Server builds with copying disabled must not inherit client collisions.
    await build(false, false);
    assert.equal(existsSync(join(buildOut, 'main.js')), true);

    // Load the published subpath through a Vite config, exactly as scripts.dev
    // does. A valid first build must reject a newly introduced watch collision.
    const consumerRequire = createRequire(resolve('examples/lite-starter/package.json'));
    for (const pluginUrl of [
      pathToFileURL(consumerRequire.resolve('@mpgd/cli/devvit')).href,
      '../clean-kit/packages/cli/src/devvit-output-collisions.ts',
    ]) {
      const watchConfig = join(buildRoot, 'vite.config.ts');
      const watchEntry = join(buildRoot, 'watch-entry.js');
      writeFileSync(
        watchConfig,
        `import { devvitOutputCollisionPlugin } from ${JSON.stringify(pluginUrl)};\nexport default { plugins: [devvitOutputCollisionPlugin()] };\n`,
      );
      writeFileSync(watchEntry, 'export const generation = 1;');
      rmSync(join(customPublic, 'main.js'), { force: true });
      const watchBuilder = await createBuilder(
        {
          configFile: watchConfig,
          root: buildRoot,
          publicDir: customPublic,
          logLevel: 'silent',
          build: {
            outDir: join(buildRoot, 'watch-dist'),
            watch: {},
            rollupOptions: { input: watchEntry, output: { entryFileNames: 'main.js' } },
          },
        },
        null,
      );
      const client = watchBuilder.environments.client;
      assert.ok(client);
      const watcher = await watchBuilder.build(client);
      assert.ok(!Array.isArray(watcher) && 'on' in watcher);
      try {
        await new Promise<void>((resolveWatch, rejectWatch) => {
          let built = false;
          const timeout = setTimeout(
            () => rejectWatch(new Error('Devvit watch collision was not reported')),
            60_000,
          );
          watcher.on('event', (event) => {
            if (event.code === 'BUNDLE_END' && !built) {
              built = true;
              writeFileSync(join(customPublic, 'main.js'), 'conflicting public output');
              writeFileSync(watchEntry, 'export const generation = 2;');
            } else if (event.code === 'ERROR') {
              clearTimeout(timeout);
              try {
                assert.equal(built, true, 'watcher must first complete a valid build');
                assert.match(
                  String(event.error),
                  /public and bundle files use the same output name/u,
                );
                resolveWatch();
              } catch (error) {
                rejectWatch(error);
              }
            }
          });
        });
      } finally {
        await watcher.close();
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.info('devvit output collision checks passed');
