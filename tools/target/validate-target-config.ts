import { existsSync } from 'node:fs';

import { isCliEntrypoint, readJsonFile } from '../io';
import { assertPlatformTargetsConfig } from './schemas';

export function validateTargetConfigFile(path = 'platform.targets.json') {
  const config = assertPlatformTargetsConfig(readJsonFile(path));

  for (const [targetName, target] of Object.entries(config.targets)) {
    if (!existsSync(target.gameApp)) {
      throw new Error(`Target ${targetName} gameApp does not exist: ${target.gameApp}`);
    }

    if (target.kind === 'web' && target.output.length === 0) {
      throw new Error(`Target ${targetName} output must not be empty.`);
    }

    if (target.kind === 'apps-in-toss' && !existsSync(target.wrapperApp)) {
      throw new Error(`Target ${targetName} wrapperApp does not exist: ${target.wrapperApp}`);
    }

    if (
      (target.kind === 'capacitor-android' || target.kind === 'capacitor-ios') &&
      !existsSync(target.shellApp)
    ) {
      throw new Error(`Target ${targetName} shellApp does not exist: ${target.shellApp}`);
    }
  }

  return config;
}

if (isCliEntrypoint(import.meta.url)) {
  const config = validateTargetConfigFile();
  console.log(`Platform targets: ${Object.keys(config.targets).join(', ')}`);
}
