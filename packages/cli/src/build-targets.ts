export type ConfiguredBuildTargets = Readonly<Record<string, unknown>>;

export const supportedBuildTargets = [
  'browser',
  'web',
  'web-preview',
  'microsoft-store',
  'msstore',
  'verse8',
  'android',
  'ios',
  'ait',
  'devvit',
  'reddit',
] as const;

const canonicalBuildTargets = new Set([
  'web-preview',
  'microsoft-store',
  'verse8',
  'android',
  'ios',
  'ait',
  'reddit',
]);

export function normalizeBuildTarget(
  target: string,
  configuredTargets: ConfiguredBuildTargets = {},
): string {
  if (target === 'web' && isConfiguredWebTarget(target, configuredTargets)) {
    return target;
  }

  const builtInTarget = normalizeBuiltInBuildTarget(target);

  if (builtInTarget !== undefined) {
    return builtInTarget;
  }

  if (isConfiguredWebTarget(target, configuredTargets)) {
    return target;
  }

  throw new Error(`Unsupported target: ${target}`);
}

export function normalizeConfiguredBuildTargets(
  configuredTargets: ConfiguredBuildTargets,
): readonly string[] {
  const targets: string[] = [];

  for (const target of Object.keys(configuredTargets)) {
    try {
      targets.push(normalizeBuildTarget(target, configuredTargets));
    } catch {
      // Unsupported custom platform kinds remain outside the generic target CLI.
    }
  }

  return [...new Set(targets)];
}

function normalizeBuiltInBuildTarget(target: string): string | undefined {
  if (target === 'browser' || target === 'web') {
    return 'web-preview';
  }

  if (target === 'msstore') {
    return 'microsoft-store';
  }

  if (target === 'devvit') {
    return 'reddit';
  }

  return canonicalBuildTargets.has(target) ? target : undefined;
}

function isConfiguredWebTarget(
  target: string,
  configuredTargets: ConfiguredBuildTargets,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(configuredTargets, target)) {
    return false;
  }

  const configuredTarget = configuredTargets[target];

  return typeof configuredTarget === 'object'
    && configuredTarget !== null
    && !Array.isArray(configuredTarget)
    && 'kind' in configuredTarget
    && configuredTarget.kind === 'web';
}
