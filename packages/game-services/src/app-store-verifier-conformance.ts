import type { PlatformEvidenceEnvelope } from '@mpgd/platform';

import {
  createAppStoreSignedTransactionEvidence,
  createAppStoreVerificationId,
  type AppStoreEnvironment,
  type AppStoreInAppPurchaseType,
  type AppStoreRevocationRecord,
  type AppStoreRevocationRegistry,
  type AppStoreTransactionPayload,
} from './app-store-verifier.js';

/** The placeholder JWS the signed-transaction evidence fixture carries; never a real signature. */
export const appStoreConformanceSignedTransaction = 'conformance.signed-transaction.jws';

export interface CreateAppStoreSignedTransactionEvidenceFixtureInput {
  readonly signedTransaction?: string;
  readonly transactionId?: string;
  readonly originalTransactionId?: string;
  readonly bundleId?: string;
}

/**
 * Builds the `app-store.signed-transaction.v1` evidence envelope a commerce v2
 * StoreKit client submits, with a placeholder JWS by default. Pair it with a
 * fake `AppStoreSignedTransactionVerifier` that answers
 * `createAppStoreTransactionConformanceFixture` for that string and, under the
 * default `server-api` policy, a fake Server API whose `signedTransactionInfo`
 * decodes to the transaction's current status; the fixture is not signed
 * evidence and contains no Apple credentials.
 */
export function createAppStoreSignedTransactionEvidenceFixture(
  input: CreateAppStoreSignedTransactionEvidenceFixtureInput = {},
): PlatformEvidenceEnvelope {
  return createAppStoreSignedTransactionEvidence({
    signedTransaction: input.signedTransaction ?? appStoreConformanceSignedTransaction,
    transactionId: input.transactionId ?? '2000000000000001',
    ...(input.originalTransactionId === undefined
      ? {}
      : { originalTransactionId: input.originalTransactionId }),
    ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }),
  });
}

export interface CreateAppStoreTransactionConformanceFixtureInput {
  readonly transactionId?: string;
  readonly originalTransactionId?: string;
  readonly bundleId?: string;
  readonly productId?: string;
  readonly purchaseDate?: number;
  readonly signedDate?: number;
  readonly environment?: AppStoreEnvironment;
  readonly type?: AppStoreInAppPurchaseType;
  readonly includeQuantity?: boolean;
  readonly quantity?: number;
  /** Set to false to omit the default signed account token for fail-closed tests. */
  readonly includeAppAccountToken?: boolean;
  readonly appAccountToken?: string;
  readonly expiresDate?: number;
  readonly revocationDate?: number;
  readonly isUpgraded?: boolean;
}

/**
 * Builds deterministic decoded JWS data for verifier and provider-adapter
 * conformance tests. The fixture is not signed evidence and contains no Apple
 * credentials, authorization tokens, private keys, or live transaction IDs.
 */
export function createAppStoreTransactionConformanceFixture(
  input: CreateAppStoreTransactionConformanceFixtureInput = {},
): AppStoreTransactionPayload {
  return {
    transactionId: input.transactionId ?? '2000000000000001',
    originalTransactionId: input.originalTransactionId ?? '2000000000000000',
    bundleId: input.bundleId ?? 'com.example.game',
    productId: input.productId ?? 'com.example.game.coins100',
    purchaseDate: input.purchaseDate ?? Date.parse('2020-01-02T03:04:05.000Z'),
    signedDate: input.signedDate ?? Date.parse('2020-01-02T03:04:06.000Z'),
    environment: input.environment ?? 'Production',
    type: input.type ?? 'Consumable',
    ...(input.includeQuantity === false ? {} : { quantity: input.quantity ?? 1 }),
    ...(input.includeAppAccountToken === false
      ? {}
      : {
          appAccountToken:
            input.appAccountToken ?? 'f15f2ed7-f92a-4c5a-90e1-15d26cd729f2',
        }),
    ...(input.expiresDate === undefined ? {} : { expiresDate: input.expiresDate }),
    ...(input.revocationDate === undefined
      ? {}
      : { revocationDate: input.revocationDate }),
    ...(input.isUpgraded === undefined ? {} : { isUpgraded: input.isUpgraded }),
  };
}

/** The rules `runAppStoreRevocationRegistryConformance` checks, in order. */
export const appStoreRevocationRegistryConformanceChecks = [
  'an unrecorded grant identity is absent',
  'the first record is kept and read back unchanged',
  'a redelivery keeps the record it repeats',
  'an older revocation arriving late keeps the later one',
  'a later revocation replaces the earlier one',
  'an unparseable revokedAt replaces a parseable one and is never replaced',
  'grant identities are independent',
  'environments are independent for the same verification id',
] as const;

/** Checked only when `reopen` is given. */
export const appStoreRevocationRegistryDurabilityCheck =
  'records survive a new registry instance over the same storage';

export interface RunAppStoreRevocationRegistryConformanceInput {
  readonly registry: AppStoreRevocationRegistry;
  /**
   * Another registry instance over the same storage, as a new Worker isolate
   * or process would build it. When given, every rule is also read back
   * through it, so a registry that only remembers in memory fails.
   */
  readonly reopen?: () => AppStoreRevocationRegistry;
  /**
   * Keeps this run's grant identities apart from earlier runs on a storage
   * that persists between them; a random id by default.
   */
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

export interface AppStoreRevocationRegistryConformanceReport {
  readonly checks: readonly string[];
  readonly passed: true;
}

/**
 * Runs the `AppStoreRevocationRegistry` contract against an implementation:
 * the latest `revokedAt` per grant identity wins, a redelivery or an older
 * notification arriving late answers `alreadyRecorded: true` and changes
 * nothing, an unparseable `revokedAt` counts as the latest, and records are
 * read back field for field. `createInMemoryAppStoreRevocationRegistry`
 * passes it; a durable registry should pass it with `reopen` as well. It
 * writes records under fresh grant identities and deletes nothing, so run it
 * on a test database: each run leaves a few rows, two of them with a
 * `revokedAt` that does not parse (never replaced or pruned by age). It
 * throws on the first rule that fails.
 */
export async function runAppStoreRevocationRegistryConformance(
  input: RunAppStoreRevocationRegistryConformanceInput,
): Promise<AppStoreRevocationRegistryConformanceReport> {
  const signal = input.signal ?? new AbortController().signal;
  const runId = input.runId ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const writer = input.registry;
  const readers = input.reopen === undefined ? [writer] : [writer, input.reopen()];
  let sequence = 0;
  const recordFor = (
    name: string,
    overrides: Partial<AppStoreRevocationRecord> = {},
  ): AppStoreRevocationRecord => {
    const transactionId = `conformance-${runId}-${name}`;
    return {
      verificationId: createAppStoreVerificationId({
        environment: 'Production',
        bundleId: 'com.example.game',
        transactionId,
      }),
      environment: 'Production',
      bundleId: 'com.example.game',
      transactionId,
      originalTransactionId: transactionId,
      productId: 'com.example.game.coins100',
      reason: 'refund',
      revokedAt: '2026-10-20T00:00:00.000Z',
      notificationType: 'REFUND',
      notificationUUID: `conformance-${runId}-${String(++sequence)}`,
      ...overrides,
    };
  };
  const record = async (value: AppStoreRevocationRecord) =>
    (await writer.recordRevocation({ record: value, signal })).alreadyRecorded;
  const expectKept = async (
    expected: AppStoreRevocationRecord | undefined,
    rule: string,
    /** Where to look when it is not `expected`'s own key (an absent record). */
    at?: Pick<AppStoreRevocationRecord, 'environment' | 'verificationId'>,
  ) => {
    for (const [index, reader] of readers.entries()) {
      const kept = await reader.findRevocation({
        verificationId: at?.verificationId ?? expected?.verificationId ?? recordFor('absent').verificationId,
        environment: at?.environment ?? expected?.environment ?? 'Production',
        bundleId: expected?.bundleId ?? 'com.example.game',
        transactionId: expected?.transactionId ?? `conformance-${runId}-absent`,
        originalTransactionId: expected?.originalTransactionId ?? `conformance-${runId}-absent`,
        signal,
      });
      assertRevocationConformance(
        sameRevocationRecord(kept, expected),
        `${rule}${index === 0 ? '' : ' (read through reopen)'}: expected ${describeRecord(expected)}, `
          + `read ${describeRecord(kept)}`,
      );
    }
  };
  const [
    absentRule,
    firstRule,
    redeliveryRule,
    olderRule,
    laterRule,
    unparseableRule,
    independentRule,
    environmentRule,
  ] = appStoreRevocationRegistryConformanceChecks;

  await expectKept(undefined, absentRule);

  const first = recordFor('first', {
    originalTransactionId: `conformance-${runId}-first-original`,
    productId: 'com.example.game.remove_ads',
    reason: 'voided',
    revokedAt: '2026-10-20T01:02:03.456Z',
    notificationType: 'REVOKE',
  });
  assertRevocationConformance(!(await record(first)), `${firstRule}: alreadyRecorded was true`);
  await expectKept(first, firstRule);

  const redelivered = { ...first, notificationUUID: `${first.notificationUUID}-redelivered` };
  // The same instant written another way is the same revocation.
  const sameInstant = {
    ...first,
    revokedAt: '2026-10-20T10:02:03.456+09:00',
    notificationUUID: `${first.notificationUUID}-same-instant`,
  };
  assertRevocationConformance(
    await record(first),
    `${redeliveryRule}: the same record answered false`,
  );
  assertRevocationConformance(
    await record(redelivered),
    `${redeliveryRule}: an equal revokedAt answered false`,
  );
  assertRevocationConformance(
    await record(sameInstant),
    `${redeliveryRule}: the same instant in another offset answered false`,
  );
  await expectKept(first, redeliveryRule);

  const later = recordFor('order', { revokedAt: '2026-10-20T02:00:00.000Z' });
  assertRevocationConformance(
    !(await record(later)),
    `${olderRule}: the first record answered true`,
  );
  const older = { ...later, revokedAt: '2026-10-20T01:00:00.000Z', notificationUUID: 'older' };
  assertRevocationConformance(await record(older), `${olderRule}: answered false`);
  await expectKept(later, olderRule);

  // Refunded, reversed (nothing recorded), and revoked again.
  const again = {
    ...later,
    reason: 'voided' as const,
    revokedAt: '2026-10-21T00:00:00.000Z',
    notificationType: 'REVOKE',
    notificationUUID: 'revoked-again',
  };
  assertRevocationConformance(!(await record(again)), `${laterRule}: answered true`);
  await expectKept(again, laterRule);
  // Compared as instants, not as text.
  const offsetLater = {
    ...again,
    revokedAt: '2026-10-21T09:30:00+09:00',
    notificationUUID: 'offset',
  };
  assertRevocationConformance(
    !(await record(offsetLater)),
    `${laterRule}: a later offset time answered true`,
  );
  await expectKept(offsetLater, laterRule);
  const lexicallyLater = {
    ...again,
    revokedAt: '2026-10-21T10:00:00+11:00',
    notificationUUID: 'lexically-later',
  };
  assertRevocationConformance(
    await record(lexicallyLater),
    `${laterRule}: an earlier instant that sorts later as text answered false`,
  );
  await expectKept(offsetLater, laterRule);

  const parseable = recordFor('unparseable', { revokedAt: '2026-10-20T00:00:00.000Z' });
  assertRevocationConformance(
    !(await record(parseable)),
    `${unparseableRule}: the first record answered true`,
  );
  const unparseable = { ...parseable, revokedAt: 'unparseable', notificationUUID: 'unparseable' };
  assertRevocationConformance(!(await record(unparseable)), `${unparseableRule}: answered true`);
  await expectKept(unparseable, unparseableRule);
  for (const revokedAt of ['2099-01-01T00:00:00.000Z', 'also-unparseable']) {
    assertRevocationConformance(
      await record({ ...parseable, revokedAt, notificationUUID: revokedAt }),
      `${unparseableRule}: ${revokedAt} replaced an unparseable record`,
    );
  }
  await expectKept(unparseable, unparseableRule);
  const unparseableFirst = recordFor('unparseable-first', { revokedAt: 'unparseable' });
  assertRevocationConformance(
    !(await record(unparseableFirst)),
    `${unparseableRule}: a first unparseable record answered true`,
  );
  assertRevocationConformance(
    await record({ ...unparseableFirst, revokedAt: '2099-01-01T00:00:00.000Z', notificationUUID: 'later' }),
    `${unparseableRule}: a parseable record replaced a first unparseable one`,
  );
  await expectKept(unparseableFirst, unparseableRule);

  const sandbox = recordFor('first', {
    environment: 'Sandbox',
    verificationId: createAppStoreVerificationId({
      environment: 'Sandbox',
      bundleId: 'com.example.game',
      transactionId: first.transactionId,
    }),
    revokedAt: '2026-10-19T00:00:00.000Z',
  });
  assertRevocationConformance(
    !(await record(sandbox)),
    `${independentRule}: another identity answered alreadyRecorded`,
  );
  await expectKept(sandbox, independentRule);
  await expectKept(first, independentRule);

  // The same verification id string in both environments: two records. The
  // Sandbox one is earlier, so a registry keyed by the id alone keeps the
  // Production record and answers it for a Sandbox lookup.
  const production = recordFor('environment', { revokedAt: '2026-10-20T12:00:00.000Z' });
  const sandboxTwin = {
    ...production,
    environment: 'Sandbox' as const,
    revokedAt: '2026-10-20T06:00:00.000Z',
    notificationUUID: `${production.notificationUUID}-sandbox`,
  };
  const productionOnly = recordFor('production-only');
  assertRevocationConformance(
    !(await record(production)),
    `${environmentRule}: Production answered true`,
  );
  await expectKept(undefined, environmentRule, { ...production, environment: 'Sandbox' });
  assertRevocationConformance(
    !(await record(sandboxTwin)),
    `${environmentRule}: a Sandbox record answered alreadyRecorded for a Production one`,
  );
  await expectKept(sandboxTwin, environmentRule);
  await expectKept(production, environmentRule);
  assertRevocationConformance(!(await record(productionOnly)), `${environmentRule}: answered true`);
  await expectKept(undefined, environmentRule, { ...productionOnly, environment: 'Sandbox' });

  return {
    checks: input.reopen === undefined
      ? [...appStoreRevocationRegistryConformanceChecks]
      : [...appStoreRevocationRegistryConformanceChecks, appStoreRevocationRegistryDurabilityCheck],
    passed: true,
  };
}

const revocationRecordKeys = [
  'verificationId',
  'environment',
  'bundleId',
  'transactionId',
  'originalTransactionId',
  'productId',
  'reason',
  'revokedAt',
  'notificationType',
  'notificationUUID',
] as const satisfies readonly (keyof AppStoreRevocationRecord)[];

function sameRevocationRecord(
  actual: AppStoreRevocationRecord | undefined,
  expected: AppStoreRevocationRecord | undefined,
): boolean {
  if (actual === undefined || expected === undefined) {
    return actual === expected;
  }
  return revocationRecordKeys.every((key) => actual[key] === expected[key]);
}

function describeRecord(record: AppStoreRevocationRecord | undefined): string {
  return record === undefined
    ? 'none'
    : `${record.revokedAt} (${record.notificationType} ${record.notificationUUID})`;
}

function assertRevocationConformance(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`App Store revocation registry conformance failed: ${message}.`);
  }
}
