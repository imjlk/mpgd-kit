import {
  allocatePlatformVersions,
  ANDROID_VERSION_CODE_MAX,
  assertPlatformVersionLedger,
  formatHostedPwaShellVersions,
  formatPlatformVersionReleaseLabel,
  HOSTED_PWA_SHELL_VERSION_POLICY,
  MICROSOFT_STORE_VERSION_COMPONENT_MAX,
  type PlatformVersionLedger,
  type PlatformVersionReleasePlan,
} from '../src/platformVersionAllocation';

const sourceSha = 'a'.repeat(40);
const kitSha = 'b'.repeat(40);
const configDigest = 'c'.repeat(64);

function createLegacyLedger(): PlatformVersionLedger {
  return {
    schemaVersion: 2,
    platforms: {
      'microsoft-store': {
        packageVersion: '1.1.0.0',
        classicPackageVersion: '1.0.0.0',
      },
      android: { versionCode: 12 },
      ios: { buildNumber: 18 },
    },
    releaseRevision: { lastAllocated: 0 },
  };
}

function createHostedPwaLedger(): PlatformVersionLedger {
  return {
    schemaVersion: 3,
    platforms: {
      'microsoft-store': {
        versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY,
        shellRevision: 0,
      },
      android: { versionCode: 0 },
    },
    releaseRevision: { lastAllocated: 0 },
  };
}

const baseInput = {
  gameId: 'example',
  gameVersion: '0.3.27',
  kitGitSha: kitSha,
  sourceGitSha: sourceSha,
  targetConfigDigest: configDigest,
};

// 1. A new plan only increments the selected targets.
{
  const ledger = createLegacyLedger();
  const { ledger: nextLedger, plan } = allocatePlatformVersions({
    ...baseInput,
    ledger,
    targets: [{ target: 'android' }, { target: 'web-preview' }],
  });

  assertEqual(plan.releaseRevision, 1, 'release revision allocates from zero');
  assertEqual(plan.releaseLabel, '0.3.27-v1', 'release label is canonical');
  assertEqual(
    plan.buildId,
    `example-0.3.27-v1-${'a'.repeat(12)}`,
    'buildId keeps the source prefix',
  );
  assertEqual(plan.targets.android?.versionCode, 13, 'android counter increments');
  assertEqual(
    plan.targets['web-preview']?.version,
    '0.3.27',
    'label targets carry the game version',
  );
  assertEqual(plan.targets['microsoft-store'], undefined, 'unselected store target stays absent');
  assertEqual(plan.targets.ios, undefined, 'unselected ios target stays absent');
  assertEqual(
    nextLedger.platforms.android?.versionCode,
    13,
    'candidate ledger advances android only',
  );
  assertDeepEqual(
    nextLedger.platforms['microsoft-store'],
    ledger.platforms['microsoft-store'],
    'unselected store ledger entry is untouched',
  );
  assertEqual(nextLedger.releaseRevision.lastAllocated, 1, 'candidate ledger records the revision');
}

// 2. Re-running a valid existing plan consumes no new numbers.
{
  const first = allocatePlatformVersions({
    ...baseInput,
    ledger: createLegacyLedger(),
    targets: [{ target: 'microsoft-store' }, { target: 'android' }, { target: 'ios' }],
  });

  const retry = allocatePlatformVersions({
    ...baseInput,
    existingPlan: first.plan,
    ledger: first.ledger,
    targets: [{ target: 'microsoft-store' }, { target: 'android' }, { target: 'ios' }],
  });

  assertEqual(
    JSON.stringify(retry.plan),
    JSON.stringify(first.plan),
    'an identical existing plan is reused verbatim',
  );
  assertEqual(
    JSON.stringify(retry.ledger),
    JSON.stringify(first.ledger),
    're-running an existing plan does not advance the ledger',
  );
}

// 3. Provenance changes reject existing-plan reuse.
{
  const first = allocatePlatformVersions({
    ...baseInput,
    ledger: createLegacyLedger(),
    targets: [{ target: 'android' }],
  });

  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      sourceGitSha: 'd'.repeat(40),
      existingPlan: first.plan,
      ledger: first.ledger,
      targets: [{ target: 'android' }],
    }), /immutable/u);
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      kitGitSha: 'e'.repeat(40),
      existingPlan: first.plan,
      ledger: first.ledger,
      targets: [{ target: 'android' }],
    }), /kitGitSha/u);
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      targetConfigDigest: 'f'.repeat(64),
      existingPlan: first.plan,
      ledger: first.ledger,
      targets: [{ target: 'android' }],
    }), /targetConfigDigest/u);
}

// 4. The same game version with new provenance is a distinct release identity.
{
  const first = allocatePlatformVersions({
    ...baseInput,
    ledger: createLegacyLedger(),
    targets: [{ target: 'android' }],
  });
  const second = allocatePlatformVersions({
    ...baseInput,
    targetConfigDigest: '0'.repeat(64),
    ledger: first.ledger,
    targets: [{ target: 'android' }],
  });

  assertEqual(second.plan.releaseRevision, 2, 'a new source context allocates the next revision');
  assertEqual(second.plan.releaseLabel, '0.3.27-v2', 'the same game version gets a new label');
  assertEqual(second.plan.buildId !== first.plan.buildId, true, 'buildIds differ');
}

// 5. The legacy Store policy and the opt-in shell policy both allocate.
{
  const legacy = allocatePlatformVersions({
    ...baseInput,
    ledger: createLegacyLedger(),
    targets: [{ target: 'microsoft-store' }],
  });
  assertEqual(
    legacy.plan.targets['microsoft-store']?.packageVersion,
    '1.1.1.0',
    'legacy modern increments',
  );
  assertEqual(
    legacy.plan.targets['microsoft-store']?.classicPackageVersion,
    '1.0.1.0',
    'legacy classic increments',
  );

  const hosted = allocatePlatformVersions({
    ...baseInput,
    ledger: createHostedPwaLedger(),
    targets: [{ target: 'microsoft-store' }],
  });
  assertEqual(
    hosted.plan.targets['microsoft-store']?.shellRevision,
    1,
    'shell revision allocates from zero',
  );
  assertEqual(
    hosted.plan.targets['microsoft-store']?.packageVersion,
    '2.0.1.0',
    'modern derives from the shell revision',
  );
  assertEqual(
    hosted.plan.targets['microsoft-store']?.classicPackageVersion,
    '1.0.1.0',
    'classic derives from the shell revision',
  );
  assertDeepEqual(
    hosted.ledger.platforms['microsoft-store'],
    { shellRevision: 1, versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY },
    'candidate ledger records the shell revision',
  );
}

// 6. Hosted-content-only work does not consume a Store shell revision.
{
  const hosted = allocatePlatformVersions({
    ...baseInput,
    ledger: createHostedPwaLedger(),
    targets: [{ target: 'microsoft-store', intent: 'hosted-content-only' }, { target: 'android' }],
  });

  assertDeepEqual(
    hosted.plan.targets['microsoft-store'],
    { intent: 'hosted-content-only', releaseLabel: '0.3.27-v1' },
    'a hosted-only entry claims no package numbers',
  );
  assertDeepEqual(
    hosted.ledger.platforms['microsoft-store'],
    { shellRevision: 0, versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY },
    'building another target does not consume the Store number',
  );
  assertEqual(hosted.plan.targets.android?.versionCode, 1, 'android still allocates');
}

// 7. Modern/classic ordering and component ceilings hold.
{
  for (const revision of [1, 2, 100, MICROSOFT_STORE_VERSION_COMPONENT_MAX]) {
    const { packageVersion, classicPackageVersion } = formatHostedPwaShellVersions(revision);
    assertEqual(
      packageVersion > classicPackageVersion,
      true,
      `modern ${packageVersion} must sort above classic ${classicPackageVersion}`,
    );
    const parts = packageVersion.split('.').map((part) => Number.parseInt(part, 10));
    assertEqual(parts[3], 0, 'the fourth component stays zero');
    assertEqual(parts[2], revision, 'the third component equals the shell revision');
    assertAtMost(parts[2] ?? 0, MICROSOFT_STORE_VERSION_COMPONENT_MAX, 'third component ceiling');
  }

  assertThrows(() => formatHostedPwaShellVersions(0), /shell revision/u);
  assertThrows(
    () => formatHostedPwaShellVersions(MICROSOFT_STORE_VERSION_COMPONENT_MAX + 1),
    /third version component/u,
  );

  const exhausted = createLegacyLedger();
  (exhausted.platforms['microsoft-store'] as { packageVersion: string }).packageVersion = '1.1.65535.0';
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      ledger: exhausted,
      targets: [{ target: 'microsoft-store' }],
    }), /exhausted/u);

  const nonzeroFourth = createLegacyLedger();
  (nonzeroFourth.platforms['microsoft-store'] as { packageVersion: string }).packageVersion = '1.1.1.1';
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      ledger: nonzeroFourth,
      targets: [{ target: 'microsoft-store' }],
    }), /fourth component/u);

  const exhaustedShell: PlatformVersionLedger = {
    ...createHostedPwaLedger(),
    platforms: {
      'microsoft-store': {
        versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY,
        shellRevision: MICROSOFT_STORE_VERSION_COMPONENT_MAX,
      },
    },
  };
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      ledger: exhaustedShell,
      targets: [{ target: 'microsoft-store' }],
    }), /exhausted/u);
}

// 8. Android/iOS counter boundaries and overflow are explicit.
{
  const androidMax: PlatformVersionLedger = {
    ...createLegacyLedger(),
    platforms: {
      ...createLegacyLedger().platforms,
      android: { versionCode: ANDROID_VERSION_CODE_MAX },
    },
  };
  assertThrows(() =>
    allocatePlatformVersions({ ...baseInput, ledger: androidMax, targets: [{ target: 'android' }] }),
    /documented maximum/u);

  const androidEdge: PlatformVersionLedger = {
    ...createLegacyLedger(),
    platforms: {
      ...createLegacyLedger().platforms,
      android: { versionCode: ANDROID_VERSION_CODE_MAX - 1 },
    },
  };
  assertEqual(
    allocatePlatformVersions({ ...baseInput, ledger: androidEdge, targets: [{ target: 'android' }] })
      .plan.targets.android?.versionCode,
    ANDROID_VERSION_CODE_MAX,
    'the edge below the maximum still allocates',
  );

  const iosMax: PlatformVersionLedger = {
    ...createLegacyLedger(),
    platforms: {
      ...createLegacyLedger().platforms,
      ios: { buildNumber: Number.MAX_SAFE_INTEGER },
    },
  };
  assertThrows(() =>
    allocatePlatformVersions({ ...baseInput, ledger: iosMax, targets: [{ target: 'ios' }] }),
    /safe integer/u);
}

// 9. Duplicate, unsupported, and malformed inputs are rejected.
{
  assertThrows(() =>
    allocatePlatformVersions({ ...baseInput, ledger: createLegacyLedger(), targets: [] as never[] }), /At least one/u);
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      ledger: createLegacyLedger(),
      targets: [{ target: 'android' }, { target: 'android' }],
    }), /duplicates/u);
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      ledger: createLegacyLedger(),
      targets: [{ target: 'play-web' as unknown as 'android' }],
    }), /Unsupported release target/u);
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      ledger: createLegacyLedger(),
      targets: [{ target: 'android', intent: 'hosted-content-only' }],
    }), /hosted-content-only/u);
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      gameVersion: '0.3.27-beta.1',
      ledger: createLegacyLedger(),
      targets: [{ target: 'android' }],
    }), /final SemVer/u);
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      sourceGitSha: 'a'.repeat(64),
      ledger: createLegacyLedger(),
      targets: [{ target: 'android' }],
    }), /40-character/u);
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      targetConfigDigest: 'c'.repeat(40),
      ledger: createLegacyLedger(),
      targets: [{ target: 'android' }],
    }), /SHA-256/u);

  assertThrows(
    () => assertPlatformVersionLedger({ ...createLegacyLedger(), schemaVersion: 1 }),
    /schema-1/u,
  );
  assertThrows(
    () => assertPlatformVersionLedger({ ...createLegacyLedger(), schemaVersion: 4 }),
    /schema/u,
  );
  assertThrows(
    () => assertPlatformVersionLedger({ ...createLegacyLedger(), releaseRevision: {} }),
    /lastAllocated/u,
  );
  assertThrows(
    () =>
      assertPlatformVersionLedger({
        ...createLegacyLedger(),
        platforms: {
          ...createLegacyLedger().platforms,
          'microsoft-store': { versionPolicy: 'some-unknown-policy', shellRevision: 1 },
        },
      }),
    /Unknown Microsoft Store version policy/u,
  );
  assertThrows(
    () =>
      assertPlatformVersionLedger({
        ...createLegacyLedger(),
        platforms: {
          ...createLegacyLedger().platforms,
          'microsoft-store': {
            versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY,
            shellRevision: 1,
            packageVersion: '2.0.1.0',
          },
        },
      }),
    /unsupported field/u,
  );
  assertThrows(
    () =>
      assertPlatformVersionLedger({
        ...createHostedPwaLedger(),
        platforms: { android: { versionCode: 1 } },
      }),
    /Schema 3 .*Microsoft Store/u,
  );
  assertThrows(
    () =>
      assertPlatformVersionLedger({
        ...createLegacyLedger(),
        platforms: {
          ...createLegacyLedger().platforms,
          android: { versionCode: Number.NaN },
        },
      }),
    /non-negative safe integer/u,
  );
  assertThrows(
    () =>
      assertPlatformVersionLedger({
        ...createLegacyLedger(),
        platforms: {
          ...createLegacyLedger().platforms,
          'microsoft-store': {
            versionPolicy: HOSTED_PWA_SHELL_VERSION_POLICY,
            shellRevision: 1,
          },
        },
      }),
    /schema-3/u,
  );
}

// 10. Failures never mutate the input ledger or existing plan.
{
  const ledger = createLegacyLedger();
  const ledgerSnapshot = JSON.stringify(ledger);
  const first = allocatePlatformVersions({
    ...baseInput,
    ledger,
    targets: [{ target: 'android' }],
  });
  const planSnapshot = JSON.stringify(first.plan);

  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      existingPlan: first.plan,
      ledger: first.ledger,
      targets: [{ target: 'android' }, { target: 'play-web' as unknown as 'android' }],
    }), /Unsupported/u);
  assertThrows(() =>
    allocatePlatformVersions({
      ...baseInput,
      existingPlan: first.plan,
      ledger: {
        ...first.ledger,
        releaseRevision: { lastAllocated: 0 },
      },
      targets: [{ target: 'android' }],
    }), /ahead of ledger/u);

  assertEqual(JSON.stringify(ledger), ledgerSnapshot, 'the input ledger object is unchanged');
  assertEqual(JSON.stringify(first.plan), planSnapshot, 'the existing plan object is unchanged');
}

// 11. Schema fixtures survive a JSON round trip through validation.
{
  const legacyFixture: unknown = JSON.parse(JSON.stringify(createLegacyLedger()));
  const hostedFixture: unknown = JSON.parse(JSON.stringify(createHostedPwaLedger()));
  assertPlatformVersionLedger(legacyFixture);
  assertPlatformVersionLedger(hostedFixture);
}

// 12. Canonical labels stay consistent with the shared release identity format.
{
  assertEqual(
    formatPlatformVersionReleaseLabel('0.3.27', 41),
    '0.3.27-v41',
    'label format is canonical',
  );
  assertThrows(() => formatPlatformVersionReleaseLabel('0.3.27-beta', 1), /final SemVer/u);
  assertThrows(() => formatPlatformVersionReleaseLabel('0.3.27', 0), /positive safe integer/u);

  const { plan } = allocatePlatformVersions({
    ...baseInput,
    ledger: createLegacyLedger(),
    targets: [{ target: 'android' }],
  });
  const label = formatPlatformVersionReleaseLabel(plan.gameVersion, plan.releaseRevision);
  assertEqual(plan.releaseLabel, label, 'the allocated plan carries the canonical label');
}

// 14. Identical inputs produce identical candidates.
{
  const input = {
    ...baseInput,
    ledger: createLegacyLedger(),
    targets: [{ target: 'microsoft-store' }, { target: 'android' }, { target: 'ios' }] as const,
  };
  const first = allocatePlatformVersions(input);
  const second = allocatePlatformVersions(input);
  assertEqual(JSON.stringify(first), JSON.stringify(second), 'allocation is deterministic');
}

// Hardened validation from local review: bounds, preservation, plan shapes.
{
  assertThrows(
    () =>
      assertPlatformVersionLedger({
        ...createLegacyLedger(),
        platforms: {
          ...createLegacyLedger().platforms,
          'microsoft-store': { classicPackageVersion: '1.0.0.0', packageVersion: '70000.0.0.0' },
        },
      }),
    /components must fit/u,
  );

  // Unknown ledger data survives into the candidate instead of vanishing.
  const extended = assertPlatformVersionLedger({
    ...createLegacyLedger(),
    published: { devvitPublic: ['1.0.0'] },
  } as unknown as PlatformVersionLedger);
  const allocated = allocatePlatformVersions({
    ...baseInput,
    ledger: extended,
    targets: [{ target: 'android' }],
  });
  assertDeepEqual(
    (allocated.ledger as unknown as { published: unknown }).published,
    { devvitPublic: ['1.0.0'] },
    'unknown top-level ledger fields are preserved in candidates',
  );

  assertThrows(
    () =>
      assertPlatformVersionLedger({
        ...createLegacyLedger(),
        platforms: {
          ...createLegacyLedger().platforms,
          'microsoft-store': {
            classicPackageVersion: '1.0.0.0',
            extra: 1,
            packageVersion: '1.1.0.0',
          },
        },
      }),
    /unsupported field/u,
  );

  const first = allocatePlatformVersions({
    ...baseInput,
    ledger: createLegacyLedger(),
    targets: [{ target: 'android' }],
  });
  assertThrows(
    () =>
      allocatePlatformVersions({
        ...baseInput,
        existingPlan: { ...first.plan, targets: { ...first.plan.targets, steam: {} } },
        ledger: first.ledger,
        targets: [{ target: 'android' }],
      }),
    /not supported/u,
  );
  assertThrows(
    () =>
      allocatePlatformVersions({
        ...baseInput,
        existingPlan: {
          ...first.plan,
          targets: { ...first.plan.targets, 'microsoft-store': { intent: 'package-upload' } },
        },
        ledger: first.ledger,
        targets: [{ target: 'android' }],
      }),
    /intent must be hosted-content-only/u,
  );

  const hostedOnly = allocatePlatformVersions({
    ...baseInput,
    ledger: createHostedPwaLedger(),
    targets: [{ target: 'microsoft-store', intent: 'hosted-content-only' }],
  });
  assertThrows(
    () =>
      allocatePlatformVersions({
        ...baseInput,
        existingPlan: {
          ...hostedOnly.plan,
          targets: {
            'microsoft-store': {
              intent: 'hosted-content-only',
              releaseLabel: '0.3.27-v1',
              shellRevision: 1,
            },
          },
        },
        ledger: hostedOnly.ledger,
        targets: [{ target: 'microsoft-store', intent: 'hosted-content-only' }],
      }),
    /unsupported field/u,
  );
}

// Existing plans may gain new targets without relabeling; ledger ties hold.
{
  const first = allocatePlatformVersions({
    ...baseInput,
    ledger: createLegacyLedger(),
    targets: [{ target: 'android' }],
  });
  const extended = allocatePlatformVersions({
    ...baseInput,
    existingPlan: first.plan,
    ledger: first.ledger,
    targets: [{ target: 'android' }, { target: 'ios' }],
  });

  assertEqual(extended.plan.releaseLabel, first.plan.releaseLabel, 'extension keeps the label');
  assertEqual(
    extended.plan.targets.android?.versionCode,
    13,
    'existing android numbers are reused',
  );
  assertEqual(
    extended.plan.targets.ios?.buildNumber,
    19,
    'the added target allocates its next counter',
  );
  assertEqual(
    extended.ledger.platforms.ios?.buildNumber,
    19,
    'the candidate ledger advances ios only now',
  );

  const intentFlip = allocatePlatformVersions({
    ...baseInput,
    ledger: createHostedPwaLedger(),
    targets: [{ target: 'microsoft-store', intent: 'hosted-content-only' }],
  });
  assertThrows(
    () =>
      allocatePlatformVersions({
        ...baseInput,
        existingPlan: intentFlip.plan,
        ledger: intentFlip.ledger,
        targets: [{ target: 'microsoft-store' }],
      }),
    /intent .* is immutable/u,
  );
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertAtMost(actual: number, maximum: number, message: string): void {
  if (actual > maximum) {
    throw new Error(`${message}: expected at most ${String(maximum)}, received ${String(actual)}.`);
  }
}

function assertDeepEqual<T>(actual: T, expected: T, message: string): void {
  const encoded = `${canonicalJson(actual)} !== ${canonicalJson(expected)}`;

  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${message}: ${encoded}.`);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

function assertThrows(action: () => void, pattern: RegExp): void {
  let message = 'no error';

  try {
    action();
  } catch (cause) {
    message = cause instanceof Error ? cause.message : String(cause);
  }

  if (!pattern.test(message)) {
    throw new Error(`Expected an error matching ${String(pattern)}, received: ${message}.`);
  }
}
