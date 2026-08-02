import { assertDeploymentTargetName } from './target-name.js';

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
  const normalizedTarget = resolveBuildTarget(target, configuredTargets);

  if (normalizedTarget !== undefined) {
    return normalizedTarget;
  }

  throw new Error(`Unsupported target: ${target}`);
}

export function normalizeConfiguredBuildTargets(
  configuredTargets: ConfiguredBuildTargets,
): readonly string[] {
  const targets = new Set<string>();

  for (const target of Object.keys(configuredTargets)) {
    const normalizedTarget = resolveBuildTarget(target, configuredTargets);

    if (normalizedTarget !== undefined) {
      targets.add(normalizedTarget);
    }
  }

  return [...targets];
}

function resolveBuildTarget(
  target: string,
  configuredTargets: ConfiguredBuildTargets,
): string | undefined {
  if (target === 'web' && isConfiguredWebTarget(target, configuredTargets)) {
    assertDeploymentTargetName(target);
    return target;
  }

  const builtInTarget = normalizeBuiltInBuildTarget(target);
  if (builtInTarget !== undefined) {
    return builtInTarget;
  }

  if (isConfiguredWebTarget(target, configuredTargets)) {
    assertDeploymentTargetName(target);
    return target;
  }

  return undefined;
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
