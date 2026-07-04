import { isCliEntrypoint } from '../io';
import { writeEffectiveTargetConfigs } from './effective-config';

export function generateEffectiveTargetConfigArtifacts(input: {
  readonly target?: string;
  readonly outputDir?: string;
} = {}) {
  return writeEffectiveTargetConfigs({
    ...(input.target === undefined ? {} : { targets: [input.target] }),
    ...(input.outputDir === undefined ? {} : { outputDir: input.outputDir }),
  });
}

if (isCliEntrypoint(import.meta.url)) {
  const [targetArg, outputDir] = process.argv.slice(2);
  const target = targetArg === undefined || targetArg === '--all' ? undefined : targetArg;
  const index = generateEffectiveTargetConfigArtifacts({
    ...(target === undefined ? {} : { target }),
    ...(outputDir === undefined ? {} : { outputDir }),
  });

  console.log(
    `Effective target config artifacts generated: ${index.artifacts
      .map((artifact) => artifact.target)
      .join(', ')}`,
  );
}
