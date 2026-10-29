import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ORPCError } from '@orpc/client';

import type { CommerceProvider, StoreId } from '@mpgd/platform/commerce';
import {
  CommerceConformanceAnotherAccountError,
  commerceConformanceJournalKey,
  runCommerceConformanceVectors,
  type CommerceConformanceBackend,
  type CommerceConformanceContext,
  type CommerceConformanceJournal,
  type CommerceConformanceVectorResult,
  type CommerceJournalRecord,
  type CommerceVerifyRequest,
  type CreateCommerceConformanceRuntimeInput,
} from '@mpgd/platform/commerce-conformance';
import {
  assertCommerceConformanceVector,
  type CommerceConformanceVector,
} from '@mpgd/platform/commerce-vectors';

import {
  GameServicesPurchaseBoundToAnotherAccountError,
  purchaseBoundToAnotherAccountCode,
  purchaseBoundToAnotherAccountStatus,
} from './another-account.js';
import {
  gameServicesBackendEndpoints,
  GameServicesBackendError,
  type PurchaseVerificationApi,
} from './client.js';
import {
  commercePurchaseOperationKind,
  createCommercePurchaseOperationKey,
  createCommerceReconciler,
  type CommercePurchaseOperationRecord,
  type CommerceReconcilerEvent,
} from './commerce-reconciler.js';
import type {
  MonetizationOperationRecord,
  MonetizationOperationStore,
} from './monetization-recovery.js';
import type { VerifyPurchaseRequest, VerifyPurchaseResponse } from './types.js';

/**
 * The fourteen RFC vectors and the six reconciler vectors (another account's
 * purchase) run through the real `createCommerceReconciler` instead of the
 * reference reconciler: the runner's `createRuntime` hook hands it the
 * vector's provider and player, and two adapters translate the reference
 * journal and backend into the `MonetizationOperationStore` and
 * `PurchaseVerificationApi` ports the reconciler speaks. The reference
 * journal keeps asserting the RFC state machine on every write, so an
 * illegal transition or a skipped revision fails the vector. The adapter
 * answers the reference backend's another-account error in the wire shape
 * the vector names: the HTTP client's 409, the oRPC error, or the in-process
 * error.
 */

/**
 * The vectors live in the checkout, not next to the compiled test: the
 * prepared CI lane runs this entry from its emit root, so the directory is
 * resolved from the source root the runner names, the working directory
 * (the package scripts run from the repository root), or the source tree.
 */
function resolveVectorsDir(directory: 'vectors' | 'reconciler-vectors'): string {
  const relative = join('docs', 'specs', 'commerce', directory);
  const candidates = [
    process.env.MPGD_TOOLS_EMIT_SOURCE_ROOT,
    process.cwd(),
    join(import.meta.dirname, '..', '..', '..'),
  ];
  for (const root of candidates) {
    if (root !== undefined && root.length > 0 && existsSync(join(root, relative))) {
      return join(root, relative);
    }
  }
  throw new Error(`Cannot locate ${relative} from ${candidates.join(', ')}.`);
}

function readVectors(directory: 'vectors' | 'reconciler-vectors'): readonly CommerceConformanceVector[] {
  const vectorsDir = resolveVectorsDir(directory);
  return readdirSync(vectorsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => assertCommerceConformanceVector(
      JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown,
    ));
}

const vectors = readVectors('vectors');
const reconcilerVectors = readVectors('reconciler-vectors');

const ledgerTarget = 'android';

/** The operation-store key of a reference journal record: shared, or player-scoped. */
function storeKeyOf(record: Pick<CommerceJournalRecord, 'key' | 'idempotencyKey' | 'playerId'>): string {
  return record.idempotencyKey === undefined
    ? createCommercePurchaseOperationKey(ledgerTarget, record.key)
    : createCommercePurchaseOperationKey(ledgerTarget, record.idempotencyKey, record.playerId);
}

/** The reference journal key of an operation-store key (`<key>@<player>` when player-scoped). */
function journalKeyOf(storeKey: string): string {
  const parsed = JSON.parse(storeKey) as unknown;
  if (
    !Array.isArray(parsed)
    || (parsed.length !== 3 && parsed.length !== 4)
    || !parsed.every((part) => typeof part === 'string')
  ) {
    throw new Error(`Unexpected operation key ${storeKey}.`);
  }
  const [, , idempotencyKey, playerId] = parsed as string[];
  return commerceConformanceJournalKey(idempotencyKey as string, playerId);
}

function toVerifyRequest(
  request: VerifyPurchaseRequest,
  record: Pick<CommerceJournalRecord, 'store' | 'purchase'>,
): CommerceVerifyRequest {
  const purchase = record.purchase;
  if (purchase === undefined) {
    throw new Error(`Journal record ${request.idempotencyKey} has no purchase to verify.`);
  }
  if (request.evidence === undefined) {
    throw new Error(`Verify request ${request.idempotencyKey} carries no evidence.`);
  }
  return {
    idempotencyKey: request.idempotencyKey,
    playerId: request.playerId,
    store: record.store,
    transactionId: request.platformTransactionId,
    token: purchase.token,
    logicalId: request.productId as CommerceVerifyRequest['logicalId'],
    quantity: purchase.quantity,
    evidence: request.evidence,
    ...(request.intent === undefined ? {} : { intent: request.intent }),
  };
}

/** The vector catalog always resolves, so a record without a kind is a reconciler bug. */
function requireKind(record: CommercePurchaseOperationRecord): CommerceJournalRecord['kind'] {
  if (record.productKind === undefined) {
    throw new Error(`Record ${record.idempotencyKey} has no product kind.`);
  }
  return record.productKind;
}

type Shadow = Pick<CommercePurchaseOperationRecord, 'input' | 'request' | 'response'>;

/**
 * The operation-store fields the reference journal does not keep, by journal
 * key, per journal: a `runtime.switchPlayer` step builds another reconciler
 * over the same journal, and it must read what the first one wrote.
 */
const shadowsByJournal = new WeakMap<CommerceConformanceJournal, Map<string, Shadow>>();

/** The reference journal as the reconciler's operation store. */
function adaptJournal(
  journal: CommerceConformanceJournal,
  playerId: string,
): MonetizationOperationStore {
  const toJournal = (record: CommercePurchaseOperationRecord): CommerceJournalRecord => ({
    key: journalKeyOf(record.key),
    ...(journalKeyOf(record.key) === record.idempotencyKey
      ? {}
      : { idempotencyKey: record.idempotencyKey }),
    revision: record.revision,
    playerId: record.playerId,
    store: record.store,
    logicalId: record.logicalId as CommerceJournalRecord['logicalId'],
    kind: requireKind(record),
    origin: record.origin,
    state: record.state,
    updatedAt: record.updatedAt,
    ...(record.purchase === undefined ? {} : { purchase: record.purchase }),
    ...(record.request === undefined
      ? {}
      : { request: toVerifyRequest(record.request, record) }),
    ...(record.ledgerEntryId === undefined ? {} : { ledgerEntryId: record.ledgerEntryId }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.revokedBy === undefined ? {} : { revokedBy: record.revokedBy }),
    ...(record.anotherAccount === undefined ? {} : { anotherAccount: record.anotherAccount }),
  });
  const shadows = shadowsByJournal.get(journal) ?? new Map<string, Shadow>();
  shadowsByJournal.set(journal, shadows);
  const fromJournal = (record: CommerceJournalRecord): MonetizationOperationRecord => {
    const shadow = shadows.get(record.key) ?? {};
    return {
      kind: commercePurchaseOperationKind,
      key: storeKeyOf(record),
      playerId: record.playerId,
      target: ledgerTarget,
      deploymentTarget: ledgerTarget,
      revision: record.revision,
      idempotencyKey: record.idempotencyKey ?? record.key,
      store: record.store,
      logicalId: record.logicalId,
      productKind: record.kind,
      origin: record.origin,
      state: record.state,
      updatedAt: record.updatedAt,
      ...(shadow.input === undefined ? {} : { input: shadow.input }),
      ...(record.purchase === undefined ? {} : { purchase: record.purchase }),
      ...(shadow.request === undefined ? {} : { request: shadow.request }),
      ...(shadow.response === undefined ? {} : { response: shadow.response }),
      ...(record.ledgerEntryId === undefined ? {} : { ledgerEntryId: record.ledgerEntryId }),
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.revokedBy === undefined ? {} : { revokedBy: record.revokedBy }),
      ...(record.anotherAccount === undefined ? {} : { anotherAccount: record.anotherAccount }),
    };
  };
  const expectCommerce = (record: MonetizationOperationRecord): CommercePurchaseOperationRecord => {
    if (record.kind !== commercePurchaseOperationKind) {
      throw new Error(`The reconciler wrote a ${record.kind} record.`);
    }
    return record;
  };
  const shadow = (record: CommercePurchaseOperationRecord): void => {
    shadows.set(journalKeyOf(record.key), {
      ...(record.input === undefined ? {} : { input: record.input }),
      ...(record.request === undefined ? {} : { request: record.request }),
      ...(record.response === undefined ? {} : { response: record.response }),
    });
  };
  return {
    async reserve(record) {
      const commerce = expectCommerce(record);
      const reserved = await journal.reserve(toJournal(commerce));
      if (reserved.created) {
        shadow(commerce);
      }
      return { created: reserved.created, record: fromJournal(reserved.record) };
    },
    async read(key) {
      const record = await journal.read(journalKeyOf(key));
      return record === undefined ? undefined : fromJournal(record);
    },
    async replace(expectedRevision, record) {
      const commerce = expectCommerce(record);
      if (commerce.revision !== expectedRevision + 1) {
        throw new Error(`Revision ${commerce.revision} does not follow ${expectedRevision}.`);
      }
      await journal.replace(expectedRevision, toJournal(commerce));
      shadow(commerce);
    },
    async listRecoverable(owner) {
      if (owner !== playerId) {
        return [];
      }
      return (await journal.listRecoverable(owner)).map(fromJournal);
    },
    async listGranted(owner) {
      if (owner !== playerId) {
        return [];
      }
      return (await journal.listGranted(owner)).map(fromJournal);
    },
    async findByTransaction(input) {
      for (const key of journal.keys) {
        const record = await journal.read(key);
        if (
          record !== undefined
          && record.playerId === input.playerId
          && record.store === input.store
          && record.purchase?.transactionId === input.transactionId
        ) {
          return fromJournal(record);
        }
      }
      return undefined;
    },
  };
}

/**
 * The reference backend's another-account error in the wire shape the vector
 * names: what the HTTP client throws for the 409 body, what the oRPC client
 * throws for the error code, or the backend's own error in process.
 */
function anotherAccountAnswerOf(error: CommerceConformanceAnotherAccountError): Error {
  switch (error.transport) {
    case 'http':
      return new GameServicesBackendError(
        gameServicesBackendEndpoints.verifyPurchase,
        purchaseBoundToAnotherAccountStatus,
        {
          error: purchaseBoundToAnotherAccountCode,
          reason: error.reason,
        },
      );
    case 'orpc':
      return new ORPCError(purchaseBoundToAnotherAccountCode, { data: { reason: error.reason } });
    case undefined:
      return new GameServicesPurchaseBoundToAnotherAccountError(error.reason);
  }
}

/**
 * The reference backend as the reconciler's verification API; the token comes
 * from the journaled purchase of the requesting player's record (its
 * player-scoped one when it has one).
 */
function adaptBackend(
  backend: CommerceConformanceBackend,
  journal: CommerceConformanceJournal,
  store: StoreId,
): PurchaseVerificationApi {
  return {
    async verifyPurchase(request) {
      const record = await journal.read(
        commerceConformanceJournalKey(request.idempotencyKey, request.playerId),
      ) ?? await journal.read(request.idempotencyKey);
      let response: Awaited<ReturnType<CommerceConformanceBackend['verifyPurchase']>>;
      try {
        response = await backend.verifyPurchase(toVerifyRequest(request, record ?? { store }));
      } catch (error) {
        throw error instanceof CommerceConformanceAnotherAccountError
          ? anotherAccountAnswerOf(error)
          : error;
      }
      if (response.status === 'granted') {
        if (response.ledgerEntryId === undefined) {
          throw new Error('A granted decision names a ledger entry.');
        }
        const answer: VerifyPurchaseResponse = {
          verified: true,
          ledgerEntryId: response.ledgerEntryId,
          alreadyProcessed: response.alreadyProcessed ?? false,
          ...(response.finalization === undefined
            ? {}
            : {
                finalization: {
                  status: response.finalization,
                  action: 'consume',
                  alreadyCompleted: response.alreadyProcessed ?? false,
                },
              }),
        };
        return answer;
      }
      return {
        verified: false,
        disposition: response.status,
        alreadyProcessed: false,
        ...(response.reason === undefined ? {} : { reason: response.reason }),
      };
    },
    async getPurchaseLedgerStatus(input) {
      return { statuses: await backend.getLedgerStatus(input.ledgerEntryIds) };
    },
  };
}

const failuresByVector = new Map<string, string[]>();
const anotherAccountByVector = new Map<string, string[]>();
/** One log per vector run; a `runtime.switchPlayer` step's reconciler appends to it. */
const logsByJournal = new WeakMap<
  CommerceConformanceJournal,
  { readonly failures: string[]; readonly anotherAccount: string[] }
>();

function createRuntime(
  input: CreateCommerceConformanceRuntimeInput,
  context: CommerceConformanceContext,
) {
  let logs = logsByJournal.get(context.journal);
  if (logs === undefined) {
    logs = { failures: [], anotherAccount: [] };
    logsByJournal.set(context.journal, logs);
    failuresByVector.set(context.vector.vector, logs.failures);
    anotherAccountByVector.set(context.vector.vector, logs.anotherAccount);
  }
  const { failures, anotherAccount } = logs;
  const provider: CommerceProvider = input.provider;
  return createCommerceReconciler({
    provider,
    backend: adaptBackend(context.backend, context.journal, provider.store),
    store: adaptJournal(context.journal, input.playerId),
    playerId: input.playerId,
    target: ledgerTarget,
    products: context.catalog.map((entry) => ({
      logicalId: entry.logicalId,
      kind: entry.kind,
      storeSku: entry.storeSku,
    })),
    now: () => input.clock.now(),
    onEvent(event: CommerceReconcilerEvent) {
      if (event.type === 'failure') {
        failures.push(
          `${event.stage}${event.idempotencyKey === undefined ? '' : `(${event.idempotencyKey})`}: ${String(event.error)}`,
        );
      } else if (event.type === 'another-account') {
        anotherAccount.push(
          `${event.record.playerId}:${event.record.idempotencyKey}:${event.reason}`,
        );
      }
    },
  });
}

function summarize(results: readonly CommerceConformanceVectorResult[]) {
  return results.map((result) => ({
    vector: result.vector,
    status: result.status,
    ...(result.failures.length === 0 ? {} : { failures: result.failures }),
    ...((failuresByVector.get(result.vector) ?? []).length === 0
      ? {}
      : { reconcilerFailures: failuresByVector.get(result.vector) }),
  }));
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual, null, 2)}.`,
    );
  }
}

assertEqual(vectors.length, 14, 'every RFC vector is loaded');
assertEqual(reconcilerVectors.length, 6, 'every reconciler vector is loaded');

const results = await runCommerceConformanceVectors(vectors, { createRuntime });
assertEqual(
  summarize(results),
  vectors.map((vector) => ({
    vector: vector.vector,
    status: 'passed' as const,
    // The scripted NETWORK finish is a transport-class failure the reconciler
    // reports and retries on the next pass; the vector expects that retry.
    ...(vector.vector === 'finish-failure-retry'
      ? { reconcilerFailures: ['finish(op-1): PlatformOperationError: Fixture finish failure.'] }
      : {}),
  })),
  'every vector passes through the game-services reconciler with the reference provider',
);

// Another account's purchase (RFC "Another account's purchase") through the
// real reconciler: the HTTP 409, the oRPC error, and a pre-answer `rejected`
// receipt park the record; another reason ends it; the purchase's own account
// recovers it under its player-scoped key; Restore Purchases resends it with
// fresh evidence. The answer is an `another-account` event, never a failure.
const reconcilerResults = await runCommerceConformanceVectors(reconcilerVectors, { createRuntime });
assertEqual(
  summarize(reconcilerResults),
  reconcilerVectors.map((vector) => ({ vector: vector.vector, status: 'passed' as const })),
  'every reconciler vector passes through the game-services reconciler',
);
const parkedKey = 'store:fixture.client-token:tx-1';
assertEqual(
  Object.fromEntries(
    reconcilerVectors.map((vector) => [
      vector.vector,
      anotherAccountByVector.get(vector.vector) ?? [],
    ]),
  ),
  {
    'another-account-http-parks': [`player-1:${parkedKey}:GOOGLE_PLAY_ACCOUNT_MISMATCH`],
    'another-account-legacy-rejected-parks': [`player-1:${parkedKey}:GOOGLE_PLAY_PROFILE_MISMATCH`],
    'another-account-orpc-parks': [`player-1:${parkedKey}:APP_STORE_ACCOUNT_TOKEN_MISMATCH`],
    'another-account-owner-recovers': [`player-1:${parkedKey}:GOOGLE_PLAY_ACCOUNT_MISMATCH`],
    'another-account-restore-resends': [`player-1:${parkedKey}:GOOGLE_PLAY_ACCOUNT_MISMATCH`],
    'rejected-other-reason-ends': [],
  },
  'the reconciler reports each parking with an another-account event',
);

// The parking is the answer's doing: the same script with a refusal for
// another reason ends the record, so the parked expectations above are real.
{
  const vector = reconcilerVectors.find(
    (candidate) => candidate.vector === 'another-account-http-parks',
  );
  if (vector === undefined) {
    throw new Error('Missing reconciler vector.');
  }
  const [result] = await runCommerceConformanceVectors(
    [
      {
        ...vector,
        steps: vector.steps.map((step) =>
          step.actor === 'backend' && step.action === 'queueVerify'
            ? {
                ...step,
                decision: { status: 'rejected' as const, reason: 'GOOGLE_PLAY_ACCOUNT_ID_MISSING' },
              }
            : step,
        ),
      },
    ],
    { createRuntime },
  );
  assertEqual(
    result?.failures.map((failure) => failure.path),
    [
      'journal.store:fixture.client-token:tx-1.length',
      'parked',
      'parked.store:fixture.client-token:tx-1',
    ],
    'a refusal for another reason is not parked',
  );
}

// The vectors that verify did so through the game-services verify port: the
// reference backend saw the purchase key, store id, transaction, and token the
// fixture expects, so the adapters did not answer on the reconciler's behalf.
const verifying = results.filter(
  (result) => vectors.find((vector) => vector.vector === result.vector)?.expect.verifyRequests
    ?.length,
);
assertEqual(verifying.length > 0, true, 'at least one vector asserts verify requests');

// A changed expectation fails, so the pass above is a real check.
{
  const vector = vectors.find((candidate) => candidate.vector === 'purchase-client-finish');
  if (vector === undefined) {
    throw new Error('Missing vector.');
  }
  const [result] = await runCommerceConformanceVectors(
    [{ ...vector, expect: { ...vector.expect, journal: { 'op-1': ['requested', 'launched'] } } }],
    { createRuntime },
  );
  assertEqual(result?.status, 'failed', 'a wrong journal expectation fails');
  assertEqual(
    result?.failures.map((failure) => failure.path),
    ['journal.op-1.length', 'journal.op-1.2'].slice(0, result?.failures.length ?? 0),
    'the journal sequence is what the matcher compares',
  );
}

console.info(
  `Commerce reconciler conformance passed: ${String(results.length)} RFC vectors and `
    + `${String(reconcilerResults.length)} reconciler vectors ran through createCommerceReconciler.`,
);
