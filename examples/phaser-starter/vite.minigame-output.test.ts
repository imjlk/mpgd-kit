import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import {
  assertMiniGameGameBundleModules,
  createRuntimeAssetOriginsBootstrap,
  resolveMiniGameBundleOutput,
} from './vite.minigame-output';
import { rewritePhaserMiniGameDynamicCode } from './vite.minigame-phaser';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'mpgd-minigame-vite-output-'));
const gameRoot = join(fixtureRoot, 'game');
const stagingRoot = join(fixtureRoot, 'staging');

try {
  mkdirSync(join(gameRoot, 'src'), { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });

  const runtimeScope = createContext({}) as typeof globalThis & {
    readonly __MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__?: readonly string[];
  };
  const runtimeOriginsBootstrap = createRuntimeAssetOriginsBootstrap(
    JSON.stringify(['https://assets.example.test']),
  );
  runInContext(runtimeOriginsBootstrap, runtimeScope);
  const firstRuntimeOrigins = runtimeScope.__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__;
  const firstRuntimeOriginsDescriptor = Object.getOwnPropertyDescriptor(
    runtimeScope,
    '__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__',
  );
  runInContext(runtimeOriginsBootstrap, runtimeScope);
  assert.equal(runtimeScope.__MPGD_MINIGAME_RUNTIME_ASSET_ORIGINS__, firstRuntimeOrigins);
  assert.deepEqual([...(firstRuntimeOrigins ?? [])], ['https://assets.example.test']);
  assert.equal(Object.isFrozen(firstRuntimeOrigins), true);
  assert.deepEqual(
    {
      configurable: firstRuntimeOriginsDescriptor?.configurable,
      enumerable: firstRuntimeOriginsDescriptor?.enumerable,
      writable: firstRuntimeOriginsDescriptor?.writable,
    },
    { configurable: false, enumerable: false, writable: false },
  );

  assert.equal(
    resolveMiniGameBundleOutput({
      gameRoot,
      outputDir: join(stagingRoot, 'runtime'),
      stagingRoot,
    }),
    resolve(realpathSync(stagingRoot), 'runtime'),
  );
  assert.throws(
    () => resolveMiniGameBundleOutput({
      gameRoot,
      outputDir: '.',
      stagingRoot: gameRoot,
    }),
    /dedicated child|must not overlap/u,
  );
  assert.throws(
    () => resolveMiniGameBundleOutput({
      gameRoot,
      outputDir: join(gameRoot, 'src'),
      stagingRoot: gameRoot,
    }),
    /must not overlap/u,
  );
  assert.throws(
    () => resolveMiniGameBundleOutput({
      gameRoot,
      outputDir: stagingRoot,
      stagingRoot,
    }),
    /dedicated child/u,
  );

  const moduleBoundary = {
    gameRoot: '/workspace/examples/phaser-starter',
    workspaceRoot: '/workspace',
  };
  assert.doesNotThrow(() => assertMiniGameGameBundleModules(
    [
      '/workspace/examples/phaser-starter/src/minigameEntry.ts',
      '/workspace/examples/phaser-starter/src/platform/buildGateways/wechat.ts',
      '/workspace/packages/platform/src/index.ts',
      '/workspace/node_modules/phaser/dist/phaser.esm.js',
      '/workspace/node_modules/@orpc/client/dist/adapters/fetch/index.mjs',
    ],
    moduleBoundary,
  ));
  for (const forbiddenModule of [
    '/workspace/adapters/wechat/src/index.ts',
    '/workspace/native-plugins/example/src/index.ts',
    '/workspace/apps/target-ait/src/main.ts',
    '/workspace/node_modules/@mpgd/adapter-wechat/dist/index.js',
    '/workspace/packages/phaser-minigame-runtime/src/index.ts',
    '/workspace/node_modules/@mpgd/phaser-minigame-runtime/dist/index.js',
    '/workspace/examples/phaser-starter/src/platform/minigameRuntime/wechat.ts?used',
  ]) {
    assert.throws(
      () => assertMiniGameGameBundleModules([forbiddenModule], moduleBoundary),
      /must not include platform runtime module/u,
    );
  }
  const linkedAdapterRoot = join(fixtureRoot, 'linked-kit', 'wechat');
  mkdirSync(join(linkedAdapterRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(linkedAdapterRoot, 'package.json'),
    '{"name":"@mpgd/adapter-wechat"}\n',
  );
  writeFileSync(join(linkedAdapterRoot, 'dist', 'package.json'), '{"type":"module"}\n');
  const standaloneBoundary = {
    gameRoot: join(fixtureRoot, 'standalone-game'),
    workspaceRoot: join(fixtureRoot, 'unrelated-workspace'),
  };
  assert.throws(
    () => assertMiniGameGameBundleModules(
      [join(linkedAdapterRoot, 'dist', 'index.js')],
      standaloneBoundary,
    ),
    /must not include platform runtime module/u,
  );
  const linkedTargetConfigRoot = join(fixtureRoot, 'linked-kit', 'target-config');
  mkdirSync(join(linkedTargetConfigRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(linkedTargetConfigRoot, 'package.json'),
    '{"name":"@mpgd/target-config"}\n',
  );
  assert.doesNotThrow(() => assertMiniGameGameBundleModules(
    [join(linkedTargetConfigRoot, 'dist', 'runtime.js')],
    standaloneBoundary,
  ));
  const linkedMpgdKitRoot = join(fixtureRoot, 'linked-mpgd-kit');
  const linkedRepositoryPackageRoot = join(linkedMpgdKitRoot, 'adapters', 'wechat');
  mkdirSync(join(linkedRepositoryPackageRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(linkedMpgdKitRoot, 'package.json'),
    JSON.stringify({
      repository: 'imjlk/mpgd-kit',
    }),
  );
  writeFileSync(
    join(linkedRepositoryPackageRoot, 'package.json'),
    JSON.stringify({
      name: 'linked-adapter-boundary',
      repository: {
        directory: './adapters/wechat/',
      },
    }),
  );
  writeFileSync(
    join(linkedRepositoryPackageRoot, 'dist', 'package.json'),
    '{"type":"module"}\n',
  );
  assert.throws(
    () => assertMiniGameGameBundleModules(
      [join(linkedRepositoryPackageRoot, 'dist', 'index.js')],
      standaloneBoundary,
    ),
    /must not include platform runtime module/u,
  );
  const thirdPartyWorkspaceRoot = join(linkedMpgdKitRoot, 'third-party-workspace');
  mkdirSync(join(thirdPartyWorkspaceRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(thirdPartyWorkspaceRoot, 'package.json'),
    JSON.stringify({
      name: '@third-party/workspace-runtime',
      repository: {
        url: 'https://evilgithub.com/imjlk/mpgd-kit.git',
        directory: 'adapters/workspace-runtime',
      },
    }),
  );
  assert.doesNotThrow(() => assertMiniGameGameBundleModules(
    [join(thirdPartyWorkspaceRoot, 'dist', 'index.js')],
    standaloneBoundary,
  ));
  const thirdPartyVendorRoot = join(linkedMpgdKitRoot, 'vendor');
  const genericThirdPartyRoot = join(thirdPartyVendorRoot, 'adapters', 'fetch');
  mkdirSync(join(genericThirdPartyRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(thirdPartyVendorRoot, 'package.json'),
    JSON.stringify({ repository: 'https://github.com/third-party/vendor.git' }),
  );
  writeFileSync(
    join(genericThirdPartyRoot, 'package.json'),
    JSON.stringify({
      name: '@third-party/generic-runtime',
      repository: { directory: 'adapters/fetch' },
    }),
  );
  assert.doesNotThrow(() => assertMiniGameGameBundleModules(
    [join(genericThirdPartyRoot, 'dist', 'index.js')],
    standaloneBoundary,
  ));
  writeFileSync(join(gameRoot, 'package.json'), '{"name":"@mpgd/example-phaser-starter"}\n');
  const thirdPartyAdapterRoot = join(gameRoot, 'node_modules', 'third-party-adapter');
  mkdirSync(join(thirdPartyAdapterRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(thirdPartyAdapterRoot, 'package.json'),
    JSON.stringify({
      name: '@third-party/runtime-tools',
      repository: {
        url: 'https://evilgithub.com/imjlk/mpgd-kit.git',
        directory: 'adapters/fetch',
      },
    }),
  );
  writeFileSync(
    join(thirdPartyAdapterRoot, 'dist', 'package.json'),
    JSON.stringify({
      name: 'third-party-dist-metadata',
      type: 'module',
      repository: 'imjlk/mpgd-kit',
    }),
  );
  assert.doesNotThrow(() => assertMiniGameGameBundleModules(
    [join(thirdPartyAdapterRoot, 'dist', 'index.js')],
    standaloneBoundary,
  ));
  const relocatedLinkedAdapterRoot = join(fixtureRoot, 'relocated', 'renamed-wechat');
  mkdirSync(join(relocatedLinkedAdapterRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(relocatedLinkedAdapterRoot, 'package.json'),
    JSON.stringify({
      name: 'renamed-wechat',
      repository: {
        url: 'imjlk/mpgd-kit',
        directory: 'adapters/wechat/',
      },
    }),
  );
  writeFileSync(
    join(relocatedLinkedAdapterRoot, 'dist', 'package.json'),
    '{"type":"module"}\n',
  );
  assert.throws(
    () => assertMiniGameGameBundleModules(
      [join(relocatedLinkedAdapterRoot, 'dist', 'index.js')],
      standaloneBoundary,
    ),
    /must not include platform runtime module/u,
  );
  const relocatedThirdPartyRoot = join(fixtureRoot, 'relocated', 'third-party-runtime');
  mkdirSync(join(relocatedThirdPartyRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(relocatedThirdPartyRoot, 'package.json'),
    JSON.stringify({
      name: 'third-party-runtime',
      repository: {
        url: 'imjlk/unrelated-repository',
        directory: 'adapters/wechat/',
      },
    }),
  );
  assert.doesNotThrow(() => assertMiniGameGameBundleModules(
    [join(relocatedThirdPartyRoot, 'dist', 'index.js')],
    standaloneBoundary,
  ));
  const installedRenamedAdapterRoot = join(gameRoot, 'node_modules', 'linked-runtime');
  mkdirSync(join(installedRenamedAdapterRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(installedRenamedAdapterRoot, 'package.json'),
    JSON.stringify({
      name: 'linked-runtime',
      repository: {
        url: 'imjlk/mpgd-kit',
        directory: 'adapters/wechat',
      },
    }),
  );
  writeFileSync(
    join(installedRenamedAdapterRoot, 'dist', 'package.json'),
    '{"type":"module"}\n',
  );
  assert.throws(
    () => assertMiniGameGameBundleModules(
      [join(installedRenamedAdapterRoot, 'dist', 'index.js')],
      standaloneBoundary,
    ),
    /must not include platform runtime module/u,
  );
  const linkedTargetAppRoot = join(fixtureRoot, 'linked-kit', 'target-devvit');
  mkdirSync(join(linkedTargetAppRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(linkedTargetAppRoot, 'package.json'),
    '{"name":"@mpgd/target-devvit"}\n',
  );
  assert.throws(
    () => assertMiniGameGameBundleModules(
      [join(linkedTargetAppRoot, 'dist', 'index.js')],
      standaloneBoundary,
    ),
    /must not include platform runtime module/u,
  );
  for (const [index, platformSdkPackage] of [
    '@apps-in-toss/web-framework',
    '@capacitor/core',
    '@devvit/web',
    '@tauri-apps/api',
    '@telegram-apps/sdk',
    '@tiktok/mini-game-sdk',
    '@ttmg/cli',
    '@verse8/platform',
  ].entries()) {
    const platformSdkRoot = join(fixtureRoot, 'linked-kit', `platform-sdk-${String(index)}`);
    mkdirSync(join(platformSdkRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(platformSdkRoot, 'package.json'),
      `${JSON.stringify({ name: platformSdkPackage })}\n`,
    );
    assert.throws(
      () => assertMiniGameGameBundleModules(
        [join(platformSdkRoot, 'dist', 'index.js')],
        standaloneBoundary,
      ),
      /must not include platform runtime module/u,
    );
  }
  const pnpmLinkedAdapterRoot = join(
    fixtureRoot,
    'store',
    '.pnpm',
    '@mpgd+adapter-wechat@0.0.0',
    'node_modules',
    '@mpgd',
    'adapter-wechat',
  );
  mkdirSync(join(pnpmLinkedAdapterRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(pnpmLinkedAdapterRoot, 'package.json'),
    '{"name":"@mpgd/adapter-wechat"}\n',
  );
  assert.throws(
    () => assertMiniGameGameBundleModules(
      [join(pnpmLinkedAdapterRoot, 'dist', 'index.js')],
      standaloneBoundary,
    ),
    /must not include platform runtime module/u,
  );

  const phaserFallback = "return this || new Function('return this')();";
  const sceneEvaluation = 'var eval2 = eval;\n'
    + '        this.loader.sceneManager.add(this.key, eval2(code));';
  const scriptInjection = "this.data = document.createElement('script');\n"
    + 'this.data.text = source;\n'
    + 'document.head.appendChild(this.data);';
  const scriptInjections = Array.from({ length: 4 }, () => scriptInjection).join('\n');
  assert.equal(
    rewritePhaserMiniGameDynamicCode(
      `before ${phaserFallback}\n${sceneEvaluation}\n${scriptInjections} after`,
    ),
    "before return globalThis;\nthrow new Error('Phaser SceneFile loader is disabled in mini-game artifacts.');\n"
      + Array.from(
        { length: 4 },
        () => "throw new Error('Phaser executable script loaders are disabled in mini-game artifacts.');",
      ).join('\n')
      + ' after',
  );
  assert.throws(
    () => rewritePhaserMiniGameDynamicCode(`${sceneEvaluation}\n${scriptInjections}`),
    /Expected exactly one Phaser 4\.2\.0 dynamic global fallback, found 0/u,
  );
  assert.throws(
    () => rewritePhaserMiniGameDynamicCode(
      `${phaserFallback}\n${phaserFallback}\n${sceneEvaluation}\n${scriptInjections}`,
    ),
    /Expected exactly one Phaser 4\.2\.0 dynamic global fallback, found 2/u,
  );
  assert.throws(
    () => rewritePhaserMiniGameDynamicCode(`${phaserFallback}\n${scriptInjections}`),
    /Expected exactly one Phaser 4\.2\.0 dynamic SceneFile evaluation, found 0/u,
  );
  assert.throws(
    () => rewritePhaserMiniGameDynamicCode(`${phaserFallback}\n${sceneEvaluation}`),
    /Expected exactly four Phaser 4\.2\.0 script injection paths, found 0/u,
  );
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

console.log('Mini-game Vite output safety tests passed.');
