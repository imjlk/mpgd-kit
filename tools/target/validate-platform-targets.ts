import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isCliEntrypoint, readJsonFile } from '../io';
import { assertDisjointMiniGameTargetOutputs } from './minigame-artifact';
import {
  assertPlatformTargetsConfigShape,
  effectiveTargetConfigOutputDir,
  loadPlatformTargetsConfig,
  releaseManifestPath,
  resolveFromPlatformTargetsBase,
} from './platform-targets';
import {
  assertDisjointWebTargetOutputs,
  assertWebArtifactOutputDirectory,
  assertWebStaticDirectory,
} from './web-artifact';

export function validatePlatformTargetsFile(path?: string) {
  const loadedConfig =
    path === undefined
      ? loadPlatformTargetsConfig()
      : {
          baseDir: dirname(resolve(path)),
          config: assertPlatformTargetsConfigShape(readJsonFile(path)),
          path: resolve(path),
        };
  const config = loadedConfig.config;
  assertDisjointWebTargetOutputs(config.targets, resolvePath, [
    { name: 'release manifest', path: releaseManifestPath(loadedConfig.baseDir) },
    {
      name: 'effective target config output',
      path: effectiveTargetConfigOutputDir(loadedConfig.baseDir),
    },
  ]);
  assertDisjointMiniGameTargetOutputs(config.targets, resolvePath, [
    { name: 'release manifest', path: releaseManifestPath(loadedConfig.baseDir) },
    {
      name: 'effective target config output',
      path: effectiveTargetConfigOutputDir(loadedConfig.baseDir),
    },
  ]);

  for (const [targetName, target] of Object.entries(config.targets)) {
    if (!existsSync(resolvePath(target.gameApp))) {
      throw new Error(`Target ${targetName} gameApp does not exist: ${target.gameApp}`);
    }

    if (target.kind === 'web' && target.output.length === 0) {
      throw new Error(`Target ${targetName} output must not be empty.`);
    }

    if (target.kind === 'web') {
      const gameAppOutput = resolve(resolvePath(target.gameApp), 'dist');
      const output = resolvePath(target.output);

      assertWebArtifactOutputDirectory(output, gameAppOutput);

      if (target.staticDir !== undefined) {
        const staticDir = resolvePath(target.staticDir);

        assertWebStaticDirectory(staticDir, output, loadedConfig.baseDir);
        assertWebStaticDirectory(staticDir, gameAppOutput, loadedConfig.baseDir);
      }
    }

    if (
      (target.kind === 'apps-in-toss' || target.kind === 'devvit-web') &&
      !existsSync(resolvePath(target.wrapperApp))
    ) {
      throw new Error(`Target ${targetName} wrapperApp does not exist: ${target.wrapperApp}`);
    }

    if (target.kind === 'apps-in-toss' && target.metadata?.sdkMajor !== 3) {
      throw new Error(`Target ${targetName} metadata.sdkMajor must be 3.`);
    }

    if (
      target.kind === 'devvit-web'
      && resolvePath(target.webDir) !== resolve(resolvePath(target.wrapperApp), 'dist/client')
    ) {
      throw new Error(
        `Target ${targetName} webDir must be <wrapperApp>/dist/client for Devvit builds.`,
      );
    }

    if (
      (target.kind === 'capacitor-android' || target.kind === 'capacitor-ios') &&
      !existsSync(resolvePath(target.shellApp))
    ) {
      throw new Error(`Target ${targetName} shellApp does not exist: ${target.shellApp}`);
    }
  }

  return config;

  function resolvePath(pathValue: string): string {
    return resolveFromPlatformTargetsBase(loadedConfig.baseDir, pathValue);
  }
}

if (isCliEntrypoint(import.meta.url)) {
  const config = validatePlatformTargetsFile();
  console.log(`Platform targets: ${Object.keys(config.targets).join(', ')}`);
}
