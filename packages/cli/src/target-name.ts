const deploymentTargetNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const reservedDeploymentTargetNames = new Set([
  'aux',
  'browser',
  'con',
  'devvit',
  'index',
  'msstore',
  'nul',
  'prn',
  'constructor',
  'prototype',
  ...Array.from({ length: 9 }, (_, index) => `com${String(index + 1)}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${String(index + 1)}`),
]);
const maximumDeploymentTargetNameLength = 64;

export function assertDeploymentTargetName(target: string): void {
  if (
    !deploymentTargetNamePattern.test(target)
    || target.length > maximumDeploymentTargetNameLength
    || reservedDeploymentTargetNames.has(target)
  ) {
    throw new Error(
      `Invalid deployment target name: ${target}. Use lowercase kebab-case and avoid reserved names.`,
    );
  }
}
