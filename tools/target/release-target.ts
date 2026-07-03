import { validateTargetConfigFile } from './validate-target-config';

const [targetName] = process.argv.slice(2);
const config = validateTargetConfigFile();

if (targetName === undefined) {
  throw new Error('Usage: pnpm release:target <target>');
}

if (config.targets[targetName] === undefined) {
  throw new Error(`Unknown target: ${targetName}`);
}

console.log(
  `Release handoff for ${targetName} is ready for platform-specific publishing automation.`,
);
