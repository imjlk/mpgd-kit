import { resolve } from 'node:path';

import {
  loadPlatformTargetsConfig,
  resolveFromPlatformTargetsBase,
} from '../target/platform-targets';
import {
  generateTargetIcons,
  inspectGeneratedTargetIcons,
  verifyExistingTargetIcons,
  verifyGeneratedTargetIcons,
} from './generator';
import { stageWrapperIcon } from './staging';

const [action = 'generate', targetList = '', profile = 'development'] = process.argv.slice(2);

if (action !== 'generate' && action !== 'verify' && action !== 'inspect') {
  throw new Error(`Unknown icon action: ${action}`);
}

const loaded = loadPlatformTargetsConfig();
const requestedTargets = targetList.length === 0
  ? Object.keys(loaded.config.targets)
  : targetList.split(',').map((target) => target.trim()).filter((target) => target.length > 0);

for (const targetName of requestedTargets) {
  const target = loaded.config.targets[targetName];

  if (target === undefined) {
    throw new Error(`Unknown target: ${targetName}`);
  }

  const generated = action === 'generate'
    ? await generateTargetIcons({
        gameRoot: loaded.baseDir,
        targetName,
        target,
        profile,
      })
    : await verifyExistingTargetIcons({
        gameRoot: loaded.baseDir,
        targetName,
        target,
        profile,
      });

  if (action === 'generate') {
    verifyGeneratedTargetIcons(generated);
    if (target.kind === 'apps-in-toss' || target.kind === 'devvit-web') {
      stageWrapperIcon(
        generated,
        resolveFromPlatformTargetsBase(loaded.baseDir, target.wrapperApp),
      );
    }

    console.log(`Generated ${targetName} icons at ${generated.outputDir}`);
  } else if (action === 'verify') {
    console.log(`Verified ${targetName} icons at ${generated.outputDir}`);
  } else {
    console.log(inspectGeneratedTargetIcons(generated));
  }
}
