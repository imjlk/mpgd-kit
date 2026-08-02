import type { TargetConfig, TargetConfigMatrix } from '@mpgd/target-config';

export type { TargetConfigMatrix } from '@mpgd/target-config';

const runtimeKinds = new Set([
  'web-preview',
  'microsoft-store-pwa',
  'capacitor-android',
  'capacitor-ios',
  'apps-in-toss',
  'devvit-web',
  'verse8-web',
]);
const releaseProfiles = new Set([
  'web-preview',
  'microsoft-store',
  'google-play',
  'app-store',
  'apps-in-toss',
  'devvit',
  'verse8',
]);
const storageSupportValues = new Set(['local', 'native', 'none']);
const integrationAvailabilityValues = new Set([
  'available',
  'disabled',
  'approval-required',
  'configuration-required',
  'unsupported',
]);
const presentationModeValues = new Set(['fullscreen', 'inline-expanded']);

export function assertRuntimeTargetConfigMatrix(input: unknown): TargetConfigMatrix {
  assertRecord(input, 'target config matrix');
  assertNonEmptyString(input.version, 'target config matrix.version');
  assertRecord(input.targets, 'target config matrix.targets');

  for (const [target, config] of Object.entries(input.targets)) {
    assertNonEmptyString(target, 'target config matrix target name');
    assertTargetConfig(config, `target config matrix.targets.${target}`);
  }

  return input as unknown as TargetConfigMatrix;
}

function assertTargetConfig(input: unknown, label: string): asserts input is TargetConfig {
  assertRecord(input, label);
  assertOneOf(input.runtime, runtimeKinds, `${label}.runtime`);

  assertRecord(input.features, `${label}.features`);
  assertBooleanFields(
    input.features,
    ['iap', 'rewardedAds', 'interstitialAds', 'leaderboard', 'localization'],
    `${label}.features`,
  );

  assertRecord(input.capabilities, `${label}.capabilities`);
  assertOneOf(input.capabilities.storage, storageSupportValues, `${label}.capabilities.storage`);
  assertBoolean(input.capabilities.localization, `${label}.capabilities.localization`);

  assertRecord(input.localization, `${label}.localization`);
  assertNonEmptyString(input.localization.fallbackLocale, `${label}.localization.fallbackLocale`);

  assertRecord(input.monetization, `${label}.monetization`);
  assertBooleanFields(
    input.monetization,
    ['iap', 'rewardedAds', 'interstitialAds'],
    `${label}.monetization`,
  );

  assertRecord(input.leaderboard, `${label}.leaderboard`);
  assertBoolean(input.leaderboard.native, `${label}.leaderboard.native`);

  assertRecord(input.release, `${label}.release`);
  assertOneOf(input.release.profile, releaseProfiles, `${label}.release.profile`);

  assertRecord(input.policy, `${label}.policy`);
  assertBooleanFields(
    input.policy,
    [
      'externalPaymentAllowed',
      'remoteExecutableCodeAllowed',
      'installOtherAppCTAAllowed',
      'requiresStoreReview',
      'requiresAitReview',
    ],
    `${label}.policy`,
  );

  if (input.integrations !== undefined) {
    assertRecord(input.integrations, `${label}.integrations`);
    for (const key of [
      'identityUpgrade',
      'presentation',
      'sharing',
      'inboundShare',
      'notifications',
    ]) {
      assertOneOf(
        input.integrations[key],
        integrationAvailabilityValues,
        `${label}.integrations.${key}`,
      );
    }
    assertOneOf(
      input.integrations.presentationMode,
      presentationModeValues,
      `${label}.integrations.presentationMode`,
    );
  }
}

function assertBooleanFields(
  input: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  for (const field of fields) {
    assertBoolean(input[field], `${label}.${field}`);
  }
}

function assertBoolean(input: unknown, label: string): asserts input is boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${label} must be a boolean.`);
  }
}

function assertNonEmptyString(input: unknown, label: string): asserts input is string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertOneOf(input: unknown, values: ReadonlySet<string>, label: string): void {
  if (typeof input !== 'string' || !values.has(input)) {
    throw new Error(`${label} has an unsupported value.`);
  }
}

function assertRecord(input: unknown, label: string): asserts input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
}
