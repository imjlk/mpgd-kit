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
import { parseIconRunArguments } from './run-arguments';
import { stageWrapperIcon } from './staging';

const { action, targets, profile } = parseIconRunArguments(process.argv.slice(2));

const loaded = loadPlatformTargetsConfig();
const requestedTargets = targets ?? Object.keys(loaded.config.targets);

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
    await verifyGeneratedTargetIcons(generated);
    if (target.kind === 'apps-in-toss' || target.kind === 'devvit-web') {
      stageWrapperIcon(
        generated,
        resolveFromPlatformTargetsBase(loaded.baseDir, target.wrapperApp),
      );
    }

    // console.info: strip.config.js removes console.log when ttsx or ttsc compiles tools.
    console.info(`Generated ${targetName} icons at ${generated.outputDir}`);
  } else if (action === 'verify') {
    console.info(`Verified ${targetName} icons at ${generated.outputDir}`);
  } else {
    console.info(inspectGeneratedTargetIcons(generated));
  }
}
