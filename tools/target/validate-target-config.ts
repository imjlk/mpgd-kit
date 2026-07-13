import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { isCliEntrypoint, readJsonFile } from '../io';
import {
  assertPlatformTargetsConfigShape,
  loadPlatformTargetsConfig,
  resolveFromPlatformTargetsBase,
} from './platform-targets';

export function validateTargetConfigFile(path?: string) {
  const loadedConfig = path === undefined
    ? loadPlatformTargetsConfig()
    : {
        baseDir: dirname(resolve(path)),
        config: assertPlatformTargetsConfigShape(readJsonFile(path)),
        path: resolve(path),
      };
  const config = loadedConfig.config;

  for (const [targetName, target] of Object.entries(config.targets)) {
    if (!existsSync(resolvePath(target.gameApp))) {
      throw new Error(`Target ${targetName} gameApp does not exist: ${target.gameApp}`);
    }

    if (target.kind === 'web' && target.output.length === 0) {
      throw new Error(`Target ${targetName} output must not be empty.`);
    }

    if (
      (target.kind === 'apps-in-toss' || target.kind === 'devvit-web') &&
      !existsSync(resolvePath(target.wrapperApp))
    ) {
      throw new Error(`Target ${targetName} wrapperApp does not exist: ${target.wrapperApp}`);
    }

    if (
      target.kind === 'devvit-web'
      && target.buildStrategy === 'devvit-vite'
      && resolvePath(target.webDir) !== resolve(resolvePath(target.wrapperApp), 'dist/client')
    ) {
      throw new Error(
        `Target ${targetName} webDir must be <wrapperApp>/dist/client for devvit-vite builds.`,
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
  const config = validateTargetConfigFile();
  console.log(`Platform targets: ${Object.keys(config.targets).join(', ')}`);
}
