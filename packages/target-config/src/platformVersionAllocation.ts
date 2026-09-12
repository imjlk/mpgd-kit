/**
 * Platform version number allocation and verification policies.
 *
 * This module answers "which number means what" for a game release without
 * touching a filesystem, a clock, the environment, git, or the network. It
 * separates four questions that must not collapse into one value:
 *
 * - `gameVersion` — the player-facing game SemVer.
 * - `releaseRevision` — an immutable build of one source/kit/config tuple,
 *   shared across targets through the `<gameVersion>-v<revision>` label.
 * - platform upload counters (`android.versionCode`, `ios.buildNumber`) —
 *   store upload ordering, never reset, and are independent of the SemVer.
 * - the Microsoft Store numbers — either an independent four-part history
 *   (legacy policy) or, behind an explicit opt-in, one `shellRevision` from
 *   which both package numbers derive.
 *
 * Everything here is a pure computation over an explicit input ledger: the
 * result is a *candidate* allocation. Nothing is reserved, persisted, or
 * serialized; see docs/PLATFORM_VERSION_ALLOCATION.md for the concurrency
 * boundaries consumers must implement themselves.
 */

import { createMpgdReleaseIdentity, isMpgdFinalSemVer } from './releaseIdentity.js';

/** Opt-in Microsoft Store policy deriving both package numbers from one shell revision. */
export const HOSTED_PWA_SHELL_VERSION_POLICY = 'hosted-pwa-shell-revision-v1';

/** Microsoft Store package version components are bounded to 16 bits. */
export const MICROSOFT_STORE_VERSION_COMPONENT_MAX = 65_535;

/** Android `versionCode` upper bound from the official versioning documentation. */
export const ANDROID_VERSION_CODE_MAX = 2_100_000_000;

/** Targets whose plan entry only carries the shared release identity. */
export const LABEL_ONLY_RELEASE_TARGETS = ['web-preview', 'reddit', 'ait', 'verse8'] as const;

/** Every target supported by the allocation policies. */
export const PLATFORM_VERSION_RELEASE_TARGETS = [
  ...LABEL_ONLY_RELEASE_TARGETS,
  'microsoft-store',
  'android',
  'ios',
] as const;

export type PlatformVersionReleaseTarget = typeof PLATFORM_VERSION_RELEASE_TARGETS[number];

/** Whether a release consumes a new platform number or only ships hosted web content. */
export type PlatformVersionIntent = 'package-upload' | 'hosted-content-only';

export interface PlatformVersionTargetRequest {
  readonly target: PlatformVersionReleaseTarget;
  /**
   * Defaults to `package-upload`. `hosted-content-only` is only meaningful for
   * `microsoft-store`: a hosted web-content change that does not upload a new
   * Windows package must not consume a Store shell revision.
   */
  readonly intent?: PlatformVersionIntent;
}

/** Legacy independent four-part Microsoft Store history. */
export interface IndependentMicrosoftStoreLedgerEntry {
  readonly packageVersion: string;
  readonly classicPackageVersion: string;
}

/** Opt-in schema-3 entry: package numbers derive from `shellRevision`. */
export interface HostedPwaShellLedgerEntry {
  readonly versionPolicy: typeof HOSTED_PWA_SHELL_VERSION_POLICY;
  readonly shellRevision: number;
}

export type MicrosoftStoreLedgerEntry =
  | IndependentMicrosoftStoreLedgerEntry
  | HostedPwaShellLedgerEntry;

export interface PlatformVersionLedger {
  readonly schemaVersion: 2 | 3;
  readonly platforms: {
    readonly 'microsoft-store'?: MicrosoftStoreLedgerEntry;
    readonly android?: { readonly versionCode: number };
    readonly ios?: { readonly buildNumber: number };
  };
  readonly releaseRevision: { readonly lastAllocated: number };
}

export interface PlatformVersionReleasePlan {
  readonly schemaVersion: 2;
  readonly gameId: string;
  readonly gameVersion: string;
  readonly releaseRevision: number;
  readonly releaseLabel: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly targetConfigDigest: string;
  readonly buildId: string;
  readonly targets: Record<string, Record<string, unknown>>;
}

export interface AllocatePlatformVersionsInput {
  readonly gameId: string;
  readonly gameVersion: string;
  readonly sourceGitSha: string;
  readonly kitGitSha: string;
  readonly targetConfigDigest: string;
  readonly ledger: PlatformVersionLedger;
  readonly targets: readonly PlatformVersionTargetRequest[];
  /** An immutable prepared plan to revalidate and extend instead of allocating a new revision. */
  readonly existingPlan?: PlatformVersionReleasePlan;
}

export interface AllocatePlatformVersionsResult {
  /** The proposed next ledger. The input ledger object is never modified. */
  readonly ledger: PlatformVersionLedger;
  /** The prepared release plan, reused or newly allocated. */
  readonly plan: PlatformVersionReleasePlan;
}

/** Private mutable working copies; every exported type stays deeply readonly at rest. */
interface MutableLedger {
  schemaVersion: 2 | 3;
  platforms: {
    'microsoft-store'?: MicrosoftStoreLedgerEntry;
    android?: { versionCode: number };
    ios?: { buildNumber: number };
  };
  releaseRevision: { lastAllocated: number };
}

interface MutablePlan {
  schemaVersion: 2;
  gameId: string;
  gameVersion: string;
  releaseRevision: number;
  releaseLabel: string;
  sourceGitSha: string;
  kitGitSha: string;
  targetConfigDigest: string;
  buildId: string;
  targets: Record<string, Record<string, unknown>>;
}

/**
 * Compute the next candidate ledger and release plan for one release.
 *
 * With `existingPlan` absent, the next global `releaseRevision` is allocated
 * and every requested target receives its next platform number (except
 * hosted-content-only Store requests). With `existingPlan` present, the plan
 * is revalidated against its provenance and the ledger; targets it already
 * covers are reused without consuming new numbers, and targets it lacks are
 * allocated — a deliberate extension point of the immutable-plan contract.
 *
 * On any failure the call throws and neither the inputs nor any returned
 * state are partially updated: intermediate work happens on private clones.
 */
export function allocatePlatformVersions(
  input: AllocatePlatformVersionsInput,
): AllocatePlatformVersionsResult {
  const targets = normalizeTargetRequests(input.targets);
  const gameId = requireToken(input.gameId, 'game id');
  const gameVersion = requireFinalVersion(input.gameVersion, 'game version');
  const sourceGitSha = requireFullGitSha(input.sourceGitSha, 'game source SHA');
  const kitGitSha = requireFullGitSha(input.kitGitSha, 'kit SHA');
  const targetConfigDigest = requireSha256Digest(input.targetConfigDigest, 'target config digest');
  const ledger = cloneLedger(input.ledger);
  const existingPlan = input.existingPlan === undefined ? undefined : clonePlan(input.existingPlan);

  const releaseRevision = existingPlan === undefined
    ? nextReleaseRevision(ledger)
    : requirePositiveInteger(existingPlan.releaseRevision, 'release plan releaseRevision');
  const releaseLabel = formatPlatformVersionReleaseLabel(gameVersion, releaseRevision);
  const buildId = `${gameId}-${releaseLabel}-${sourceGitSha.slice(0, 12)}`;
  const plan: MutablePlan = existingPlan ?? {
    schemaVersion: 2,
    gameId,
    gameVersion,
    releaseRevision,
    releaseLabel,
    sourceGitSha,
    kitGitSha,
    targetConfigDigest,
    buildId,
    targets: {},
  };

  if (plan.releaseLabel !== releaseLabel) {
    throw new Error(
      `Existing release plan label ${plan.releaseLabel} is immutable (${releaseLabel} expected).`,
    );
  }

  if (plan.buildId !== buildId) {
    throw new Error(
      `Existing release plan buildId ${plan.buildId} is immutable (${buildId} expected).`,
    );
  }

  assertPlanIdentity(plan, { gameId, gameVersion, sourceGitSha, kitGitSha, targetConfigDigest });
  if (existingPlan !== undefined) {
    assertPlanReleaseRevision(plan, ledger);
    assertPlanPlatformVersions(plan, ledger);
  }

  for (const { target, intent } of targets) {
    const existingEntry = plan.targets[target];

    if (existingEntry !== undefined) {
      assertPlanTargetIntent(existingEntry, target, intent);
      continue;
    }

    plan.targets[target] = allocateTargetVersion(
      ledger,
      target,
      gameVersion,
      plan.buildId,
      releaseLabel,
      intent,
    );
  }

  if (existingPlan === undefined) {
    recordAllocatedReleaseRevision(ledger, releaseRevision);
  }

  return { ledger, plan };
}

/**
 * Derive both Microsoft Store package numbers from one shell revision:
 * `modern = 2.0.<revision>.0` is always greater than `classic = 1.0.<revision>.0`,
 * the fourth component stays `0`, and the third is bounded to 16 bits.
 */
export function formatHostedPwaShellVersions(shellRevision: number): {
  readonly packageVersion: string;
  readonly classicPackageVersion: string;
} {
  const revision = requireShellRevision(shellRevision, 'Microsoft Store shell revision', false);

  return {
    packageVersion: `2.0.${String(revision)}.0`,
    classicPackageVersion: `1.0.${String(revision)}.0`,
  };
}

/**
 * Validate a platform version ledger without allocating anything. Rejects
 * legacy schema-1 ledgers: converting an operational ledger is an explicit
 * migration decision this module never performs.
 */
export function assertPlatformVersionLedger(value: unknown): PlatformVersionLedger {
  return cloneLedger(value);
}

export function formatPlatformVersionReleaseLabel(
  gameVersion: string,
  releaseRevision: number,
): string {
  return createMpgdReleaseIdentity({ gameVersion, releaseRevision }).label;
}

function cloneLedger(value: unknown): MutableLedger {
  const ledger = requireObject(structuredClone(value), 'platform version ledger');

  if (ledger.schemaVersion === 1) {
    throw new Error(
      'Legacy schema-1 platform version ledgers are not converted automatically; '
        + 'migrate the ledger explicitly before using the allocation policies.',
    );
  }

  if (ledger.schemaVersion !== 2 && ledger.schemaVersion !== 3) {
    throw new Error('Unsupported platform version ledger schema.');
  }

  const platforms = requireObject(ledger.platforms, 'platform version ledger platforms');
  // Preserve unknown top-level fields and unknown platform keys verbatim so a
  // candidate ledger never drops data this core does not model; consumers
  // persist candidates and silent field loss would corrupt their ledgers.
  const normalizedPlatforms = { ...platforms } as Record<string, unknown>;

  if (platforms.android !== undefined) {
    normalizedPlatforms.android = {
      versionCode: requireNonNegativeInteger(
        requireObject(platforms.android, 'Android ledger entry').versionCode,
        'Android ledger versionCode',
      ),
    };
  }

  if (platforms.ios !== undefined) {
    normalizedPlatforms.ios = {
      buildNumber: requireNonNegativeInteger(
        requireObject(platforms.ios, 'iOS ledger entry').buildNumber,
        'iOS ledger buildNumber',
      ),
    };
  }

  const microsoftStore = platforms['microsoft-store'];

  if (microsoftStore !== undefined) {
    normalizedPlatforms['microsoft-store'] = normalizeMicrosoftStoreLedgerEntry(
      microsoftStore,
      ledger.schemaVersion,
    );
  } else if (ledger.schemaVersion === 3) {
    throw new Error('Schema 3 platform version ledgers must carry a Microsoft Store entry.');
  }

  return {
    ...ledger,
    platforms: normalizedPlatforms,
    releaseRevision: {
      lastAllocated: requireNonNegativeInteger(
        requireObject(ledger.releaseRevision, 'platform version ledger releaseRevision').lastAllocated,
        'platform version ledger lastAllocated',
      ),
    },
  } as MutableLedger;
}

function normalizeMicrosoftStoreLedgerEntry(
  value: unknown,
  schemaVersion: 2 | 3,
): MicrosoftStoreLedgerEntry {
  const entry = requireObject(value, 'Microsoft Store ledger entry');
  rejectUnknownFields(
    entry,
    entry.versionPolicy === undefined
      ? ['classicPackageVersion', 'packageVersion']
      : ['shellRevision', 'versionPolicy'],
    'Microsoft Store ledger entry',
  );

  if (entry.versionPolicy !== undefined) {
    if (entry.versionPolicy !== HOSTED_PWA_SHELL_VERSION_POLICY) {
      throw new Error(
        `Unknown Microsoft Store version policy ${String(entry.versionPolicy)}; `
          + `the only supported opt-in policy is ${HOSTED_PWA_SHELL_VERSION_POLICY}.`,
      );
    }
    const shellRevision = requireShellRevision(
      entry.shellRevision,
      'Microsoft Store ledger shellRevision',
      true,
    );
    if (schemaVersion !== 3) {
      throw new Error(
        `The ${HOSTED_PWA_SHELL_VERSION_POLICY} policy requires a schema-3 ledger; `
          + 'opt in explicitly instead of mixing it into a schema-2 history.',
      );
    }
    return { versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY, shellRevision };
  }

  if (schemaVersion === 3) {
    throw new Error(
      `Schema 3 Microsoft Store ledger versionPolicy must be ${HOSTED_PWA_SHELL_VERSION_POLICY}.`,
    );
  }

  return {
    packageVersion: requireFourPartVersion(entry.packageVersion, 'Microsoft Store package version'),
    classicPackageVersion: requireFourPartVersion(
      entry.classicPackageVersion,
      'Microsoft Store classic package version',
    ),
  };
}

function clonePlan(value: unknown): MutablePlan {
  const plan = requireObject(structuredClone(value), 'release plan');

  if (plan.schemaVersion !== 2) {
    throw new Error('Unsupported release plan schema.');
  }

  requireToken(plan.gameId, 'release plan gameId');
  requireFinalVersion(plan.gameVersion, 'release plan gameVersion');
  requirePositiveInteger(plan.releaseRevision, 'release plan releaseRevision');
  validatePlanTargets(requireObject(plan.targets, 'release plan targets'));
  requireFullGitSha(plan.sourceGitSha, 'release plan sourceGitSha');
  requireFullGitSha(plan.kitGitSha, 'release plan kitGitSha');
  requireSha256Digest(plan.targetConfigDigest, 'release plan targetConfigDigest');
  requireString(plan.buildId, 'release plan buildId');
  requireString(plan.releaseLabel, 'release plan releaseLabel');

  return plan as unknown as MutablePlan;
}

/**
 * Shape-check every target entry of an existing plan. Entries must match the
 * exact form this module allocates so a hand-edited plan cannot smuggle
 * unvalidated numbers or unknown targets into a candidate release.
 */
function validatePlanTargets(targets: Record<string, unknown>): void {
  for (const [target, value] of Object.entries(targets)) {
    if (!(PLATFORM_VERSION_RELEASE_TARGETS as readonly string[]).includes(target)) {
      throw new Error(`Release plan target ${target} is not supported by the allocation policies.`);
    }

    const entry = requireObject(value, `release plan target ${target}`);

    if ((LABEL_ONLY_RELEASE_TARGETS as readonly string[]).includes(target)) {
      rejectUnknownFields(
        entry,
        ['buildId', 'releaseLabel', 'version'],
        `release plan target ${target}`,
      );
      requireString(entry.buildId, `release plan target ${target} buildId`);
      requireString(entry.releaseLabel, `release plan target ${target} releaseLabel`);
      requireFinalVersion(entry.version, `release plan target ${target} version`);
      continue;
    }

    if (target === 'android') {
      rejectUnknownFields(
        entry,
        ['releaseLabel', 'versionCode', 'versionName'],
        'release plan android target',
      );
      requireString(entry.releaseLabel, 'release plan android releaseLabel');
      requirePositiveInteger(entry.versionCode, 'release plan android versionCode');
      requireFinalVersion(entry.versionName, 'release plan android versionName');
      continue;
    }

    if (target === 'ios') {
      rejectUnknownFields(
        entry,
        ['buildNumber', 'marketingVersion', 'releaseLabel'],
        'release plan ios target',
      );
      requirePositiveInteger(entry.buildNumber, 'release plan ios buildNumber');
      requireFinalVersion(entry.marketingVersion, 'release plan ios marketingVersion');
      requireString(entry.releaseLabel, 'release plan ios releaseLabel');
      continue;
    }

    if (entry.intent !== undefined) {
      if (entry.intent !== 'hosted-content-only') {
        throw new Error(
          `Release plan microsoft-store intent must be hosted-content-only when present; `
            + `received ${String(entry.intent)}.`,
        );
      }
      rejectUnknownFields(entry, ['intent', 'releaseLabel'], 'release plan microsoft-store target');
      requireString(entry.releaseLabel, 'release plan microsoft-store releaseLabel');
      continue;
    }

    if (entry.versionPolicy === HOSTED_PWA_SHELL_VERSION_POLICY) {
      rejectUnknownFields(
        entry,
        [
          'classicPackageVersion',
          'packageVersion',
          'releaseLabel',
          'shellRevision',
          'versionPolicy',
        ],
        'release plan microsoft-store target',
      );
      requireShellRevision(
        entry.shellRevision,
        'release plan microsoft-store shellRevision',
        false,
      );
      const derived = formatHostedPwaShellVersions(entry.shellRevision as number);
      assertEqual(
        entry.packageVersion,
        derived.packageVersion,
        'release plan microsoft-store package version',
      );
      assertEqual(
        entry.classicPackageVersion,
        derived.classicPackageVersion,
        'release plan microsoft-store classic package version',
      );
    } else {
      rejectUnknownFields(
        entry,
        ['classicPackageVersion', 'packageVersion', 'releaseLabel'],
        'release plan microsoft-store target',
      );
      requireFourPartVersion(entry.packageVersion, 'release plan microsoft-store package version');
      requireFourPartVersion(
        entry.classicPackageVersion,
        'release plan microsoft-store classic package version',
      );
    }
    requireString(entry.releaseLabel, 'release plan microsoft-store releaseLabel');
  }
}

function rejectUnknownFields(entry: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label} has an unsupported field: ${key}.`);
    }
  }
}

function normalizeTargetRequests(values: readonly PlatformVersionTargetRequest[]): readonly {
  readonly target: PlatformVersionReleaseTarget;
  readonly intent: PlatformVersionIntent;
}[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('At least one release target is required.');
  }

  const normalized = values.map((request) => {
    const entry = requireObject(request, 'release target request');
    const target = requireToken(entry.target, 'release target');

    if (!(PLATFORM_VERSION_RELEASE_TARGETS as readonly string[]).includes(target)) {
      throw new Error(`Unsupported release target: ${target}`);
    }

    const intent = (entry.intent ?? 'package-upload') as PlatformVersionIntent;

    if (intent !== 'package-upload' && intent !== 'hosted-content-only') {
      throw new Error(`Unknown release intent: ${String(entry.intent)}`);
    }

    if (intent === 'hosted-content-only' && target !== 'microsoft-store') {
      throw new Error(
        `hosted-content-only is only meaningful for microsoft-store; ${target} has no hosted content split.`,
      );
    }

    return { target: target as PlatformVersionReleaseTarget, intent };
  });

  const seen = new Set<string>();

  for (const { target } of normalized) {
    if (seen.has(target)) {
      throw new Error('Release targets must not contain duplicates.');
    }
    seen.add(target);
  }

  return normalized;
}

function allocateTargetVersion(
  ledger: MutableLedger,
  target: PlatformVersionReleaseTarget,
  gameVersion: string,
  buildId: string,
  releaseLabel: string,
  intent: PlatformVersionIntent,
): Record<string, unknown> {
  if ((LABEL_ONLY_RELEASE_TARGETS as readonly string[]).includes(target)) {
    return { buildId, releaseLabel, version: gameVersion };
  }

  switch (target) {
    case 'microsoft-store': {
      const current = requireObject(
        ledger.platforms['microsoft-store'],
        'Microsoft Store ledger entry',
      );

      if (intent === 'hosted-content-only') {
        // Hosted web content that does not upload a Windows package must not
        // consume a Store shell revision or four-part number.
        return { intent: 'hosted-content-only', releaseLabel };
      }

      if (current.versionPolicy === HOSTED_PWA_SHELL_VERSION_POLICY) {
        // A fresh hosted-PWA ledger starts at shellRevision 0 (nothing
        // allocated yet); nextShellRevision validates the non-negative range.
        const nextRevision = nextShellRevision(current.shellRevision);
        const { classicPackageVersion, packageVersion } = formatHostedPwaShellVersions(
          nextRevision,
        );
        ledger.platforms['microsoft-store'] = {
          versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY,
          shellRevision: nextRevision,
        };
        return {
          classicPackageVersion,
          packageVersion,
          releaseLabel,
          shellRevision: nextRevision,
          versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY,
        };
      }

      const packageVersion = incrementFourPartVersion(
        current.packageVersion,
        'Microsoft Store package version',
      );
      const classicPackageVersion = incrementFourPartVersion(
        current.classicPackageVersion,
        'Microsoft Store classic package version',
      );
      ledger.platforms['microsoft-store'] = { packageVersion, classicPackageVersion };
      return { classicPackageVersion, packageVersion, releaseLabel };
    }
    case 'android': {
      const current = requireObject(ledger.platforms.android, 'Android ledger entry');
      const versionCode = requireNonNegativeInteger(
        current.versionCode,
        'Android ledger versionCode',
      );

      if (versionCode >= ANDROID_VERSION_CODE_MAX) {
        throw new Error(
          `Android versionCode has reached its documented maximum of ${String(ANDROID_VERSION_CODE_MAX)}.`,
        );
      }

      ledger.platforms.android = { versionCode: versionCode + 1 };
      return { releaseLabel, versionCode: versionCode + 1, versionName: gameVersion };
    }
    case 'ios': {
      const current = requireObject(ledger.platforms.ios, 'iOS ledger entry');
      const buildNumber = requireNonNegativeInteger(current.buildNumber, 'iOS ledger buildNumber');

      if (buildNumber >= Number.MAX_SAFE_INTEGER) {
        throw new Error('iOS buildNumber has exhausted the safe integer range.');
      }

      ledger.platforms.ios = { buildNumber: buildNumber + 1 };
      return { buildNumber: buildNumber + 1, marketingVersion: gameVersion, releaseLabel };
    }
    default:
      throw new Error(`Unsupported release target: ${target}`);
  }
}

function assertPlanIdentity(
  plan: MutablePlan,
  expected: {
    readonly gameId: string;
    readonly gameVersion: string;
    readonly sourceGitSha: string;
    readonly kitGitSha: string;
    readonly targetConfigDigest: string;
  },
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (plan[key as keyof MutablePlan] !== value) {
      throw new Error(
        `Existing release plan ${key} is immutable `
          + `(${String(plan[key as keyof MutablePlan])} !== ${String(value)}). `
          + 'Prepare a new immutable release plan; a target-only release may retain '
          + 'the game SemVer but receives the next global release revision.',
      );
    }
  }
}

function assertPlanTargetIntent(
  entry: Record<string, unknown>,
  target: string,
  intent: PlatformVersionIntent,
): void {
  const recordedIntent = entry.intent === undefined ? 'package-upload' : entry.intent;

  if (recordedIntent !== intent) {
    throw new Error(
      `Existing release plan target ${target} intent ${String(recordedIntent)} is immutable (${intent} requested).`,
    );
  }
}

function assertPlanReleaseRevision(plan: MutablePlan, ledger: MutableLedger): void {
  const lastAllocated = requireNonNegativeInteger(
    ledger.releaseRevision.lastAllocated,
    'platform version ledger lastAllocated',
  );

  if (plan.releaseRevision > lastAllocated) {
    throw new Error(
      `Existing release plan releaseRevision ${String(plan.releaseRevision)} is ahead of ledger ${String(lastAllocated)}.`,
    );
  }
}

function assertPlanPlatformVersions(plan: MutablePlan, ledger: MutableLedger): void {
  const microsoftStore = plan.targets['microsoft-store'];

  if (microsoftStore !== undefined) {
    const expected = requireObject(
      ledger.platforms['microsoft-store'],
      'Microsoft Store ledger entry',
    );
    const actual = requireObject(microsoftStore, 'existing Microsoft Store plan');

    if (actual.intent !== undefined) {
      if (actual.intent !== 'hosted-content-only') {
        throw new Error(`Unknown Microsoft Store plan intent: ${String(actual.intent)}.`);
      }
      if (actual.packageVersion !== undefined || actual.classicPackageVersion !== undefined) {
        throw new Error(
          'A hosted-content-only Microsoft Store plan must not claim package versions.',
        );
      }
    } else if (expected.versionPolicy === HOSTED_PWA_SHELL_VERSION_POLICY) {
      if (actual.versionPolicy !== HOSTED_PWA_SHELL_VERSION_POLICY) {
        throw new Error(
          `Existing Microsoft Store plan versionPolicy must be ${HOSTED_PWA_SHELL_VERSION_POLICY}.`,
        );
      }
      const shellRevision = requireShellRevision(
        actual.shellRevision,
        'existing Microsoft Store plan shellRevision',
        false,
      );
      assertNumberNotAhead(
        shellRevision,
        requireShellRevision(expected.shellRevision, 'Microsoft Store ledger shellRevision', true),
        'Microsoft Store shell revision',
      );
      const derived = formatHostedPwaShellVersions(shellRevision);
      assertEqual(
        actual.packageVersion,
        derived.packageVersion,
        'existing Microsoft Store package version',
      );
      assertEqual(
        actual.classicPackageVersion,
        derived.classicPackageVersion,
        'existing Microsoft Store classic package version',
      );
    } else {
      assertVersionNotAhead(
        actual.packageVersion,
        expected.packageVersion,
        'Microsoft Store package version',
      );
      assertVersionNotAhead(
        actual.classicPackageVersion,
        expected.classicPackageVersion,
        'Microsoft Store classic package version',
      );
    }
  }

  const android = plan.targets.android;

  if (android !== undefined) {
    assertNumberNotAhead(
      requirePositiveInteger(
        requireObject(android, 'existing Android plan').versionCode,
        'existing Android plan versionCode',
      ),
      requireObject(ledger.platforms.android, 'Android ledger entry').versionCode,
      'Android versionCode',
    );
  }

  const ios = plan.targets.ios;

  if (ios !== undefined) {
    assertNumberNotAhead(
      requirePositiveInteger(
        requireObject(ios, 'existing iOS plan').buildNumber,
        'existing iOS plan buildNumber',
      ),
      requireObject(ledger.platforms.ios, 'iOS ledger entry').buildNumber,
      'iOS buildNumber',
    );
  }
}

function incrementFourPartVersion(value: unknown, label: string): string {
  const version = requireFourPartVersion(value, label);
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));

  if (parts[3] !== 0) {
    throw new Error(
      `${label} must reserve the fourth component as 0 for Windows Store compatibility: ${version}`,
    );
  }

  if ((parts[2] ?? 0) >= MICROSOFT_STORE_VERSION_COMPONENT_MAX) {
    throw new Error(`${label} has exhausted its third numeric component: ${version}`);
  }

  parts[2] = (parts[2] ?? 0) + 1;
  return parts.join('.');
}

function nextShellRevision(value: unknown): number {
  const revision = requireShellRevision(value, 'Microsoft Store ledger shellRevision', true);

  if (revision >= MICROSOFT_STORE_VERSION_COMPONENT_MAX) {
    throw new Error(`Microsoft Store shell revision range is exhausted at ${String(revision)}.`);
  }

  return revision + 1;
}

function requireShellRevision(value: unknown, label: string, allowZero: boolean): number {
  const revision = allowZero
    ? requireNonNegativeInteger(value, label)
    : requirePositiveInteger(value, label);

  if (revision > MICROSOFT_STORE_VERSION_COMPONENT_MAX) {
    throw new Error(
      `${label} must fit the Microsoft Store third version component (0-${String(MICROSOFT_STORE_VERSION_COMPONENT_MAX)}).`,
    );
  }

  return revision;
}

function nextReleaseRevision(ledger: MutableLedger): number {
  const lastAllocated = requireNonNegativeInteger(
    ledger.releaseRevision.lastAllocated,
    'platform version ledger lastAllocated',
  );

  if (lastAllocated >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Platform version ledger has exhausted its release revision range.');
  }

  return lastAllocated + 1;
}

function recordAllocatedReleaseRevision(ledger: MutableLedger, releaseRevision: number): void {
  const lastAllocated = requireNonNegativeInteger(
    ledger.releaseRevision.lastAllocated,
    'platform version ledger lastAllocated',
  );

  if (releaseRevision !== lastAllocated + 1) {
    throw new Error(
      `Release revision ${String(releaseRevision)} does not follow ledger revision ${String(lastAllocated)}.`,
    );
  }

  ledger.releaseRevision = { lastAllocated: releaseRevision };
}

function requireFourPartVersion(value: unknown, label: string): string {
  const version = requireString(value, label);

  if (!/^\d+\.\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`${label} must be a four-part numeric version: ${version}`);
  }

  for (const part of version.split('.')) {
    if (Number.parseInt(part, 10) > MICROSOFT_STORE_VERSION_COMPONENT_MAX) {
      throw new Error(
        `${label} components must fit 0-${String(MICROSOFT_STORE_VERSION_COMPONENT_MAX)}: ${version}`,
      );
    }
  }

  return version;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function requireToken(value: unknown, label: string): string {
  const token = requireString(value, label);

  if (!/^[0-9A-Za-z._-]+$/u.test(token)) {
    throw new Error(`${label} has unsupported characters: ${token}`);
  }

  return token;
}

/** Git revisions are full lowercase 40-character SHA-1 values. */
function requireFullGitSha(value: unknown, label: string): string {
  const sha = requireString(value, label);

  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }

  return sha;
}

/** Target configuration digests are 64-character SHA-256 values, distinct from Git revisions. */
function requireSha256Digest(value: unknown, label: string): string {
  const digest = requireString(value, label);

  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error(`${label} must be a 64-character SHA-256 digest.`);
  }

  return digest;
}

function requireFinalVersion(value: unknown, label: string): string {
  const version = requireString(value, label);

  if (!isMpgdFinalSemVer(version)) {
    throw new Error(
      `${label} must be a final SemVer without prerelease/build metadata: ${version}`,
    );
  }

  return version;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }

  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }

  return value;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} ${String(actual)} must equal ${String(expected)}.`);
  }
}

function assertVersionNotAhead(actual: unknown, latest: unknown, label: string): void {
  const actualParts = requireFourPartVersion(actual, `existing ${label}`)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  const latestParts = requireFourPartVersion(latest, `ledger ${label}`)
    .split('.')
    .map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < actualParts.length; index += 1) {
    const actualPart = actualParts[index] ?? 0;
    const latestPart = latestParts[index] ?? 0;

    if (actualPart === latestPart) {
      continue;
    }

    if (actualPart > latestPart) {
      throw new Error(
        `Existing release plan ${label} ${String(actual)} is ahead of ledger ${String(latest)}; the ledger cannot decrease.`,
      );
    }

    return;
  }
}

function assertNumberNotAhead(actual: number, latest: unknown, label: string): void {
  const normalizedLatest = requireNonNegativeInteger(latest, `ledger ${label}`);

  if (actual > normalizedLatest) {
    throw new Error(
      `Existing release plan ${label} ${String(actual)} is ahead of ledger ${String(normalizedLatest)}; the ledger cannot decrease.`,
    );
  }
}
