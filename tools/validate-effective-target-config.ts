import { isCliEntrypoint } from './io';
import { validateEffectiveTargetConfigMatrix } from './target/effective-config';

export function validateEffectiveTargetConfig() {
  return validateEffectiveTargetConfigMatrix(
    undefined,
    readTargetFilterFromEnv('MPGD_TARGET_CONFIG_TARGETS'),
  );
}

if (isCliEntrypoint(import.meta.url)) {
  const matrix = validateEffectiveTargetConfig();
  console.log(
    `Effective target config ${matrix.version}: ${Object.keys(matrix.targets).length} targets`,
  );
}

function readTargetFilterFromEnv(name: string): readonly string[] | undefined {
  const raw = process.env[name];

  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  return raw
    .split(',')
    .map((target) => target.trim())
    .filter((target) => target.length > 0);
}
