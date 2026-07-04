import { isCliEntrypoint } from './io';
import { validateEffectiveTargetConfigMatrix } from './target/effective-config';

export function validateEffectiveTargetConfig() {
  return validateEffectiveTargetConfigMatrix();
}

if (isCliEntrypoint(import.meta.url)) {
  const matrix = validateEffectiveTargetConfig();
  console.log(
    `Effective target config ${matrix.version}: ${Object.keys(matrix.targets).length} targets`,
  );
}
