import { validateEffectiveTargetConfigMatrix } from './effective-config';
import { assertPlatformTargetBuildEmitterAvailable } from './platform-targets';
import { validatePlatformTargetsFile } from './validate-platform-targets';

const [targetName] = process.argv.slice(2);
const config = validatePlatformTargetsFile();
validateEffectiveTargetConfigMatrix();

if (targetName === undefined) {
  throw new Error('Usage: pnpm release:target <target>');
}

const target = config.targets[targetName];

if (target === undefined) {
  throw new Error(`Unknown target: ${targetName}`);
}

assertPlatformTargetBuildEmitterAvailable(target, targetName);

console.log(
  `Release handoff for ${targetName} is ready for platform-specific publishing automation.`,
);
