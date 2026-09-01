import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import {
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
