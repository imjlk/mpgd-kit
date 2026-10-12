import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommerceProvider, StoreId } from '@mpgd/platform/commerce';
import {
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

import type { PurchaseVerificationApi } from './client.js';
import {
  commercePurchaseOperationKind,
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
 * The fourteen RFC vectors run through the real `createCommerceReconciler`
 * instead of the reference reconciler: the runner's `createRuntime` hook
 * hands it the vector's provider, and two adapters translate the reference
 * journal and backend into the `MonetizationOperationStore` and
 * `PurchaseVerificationApi` ports the reconciler speaks. The reference
 * journal keeps asserting the RFC state machine on every write, so an
 * illegal transition or a skipped revision fails the vector.
 */

const vectorsDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'specs',
  'commerce',
  'vectors',
);
const vectors: readonly CommerceConformanceVector[] = readdirSync(vectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => assertCommerceConformanceVector(
    JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown,
  ));

const ledgerTarget = 'android';

function storeKeyOf(idempotencyKey: string): string {
  return JSON.stringify([ledgerTarget, commercePurchaseOperationKind, idempotencyKey]);
}

function idempotencyKeyOf(storeKey: string): string {
  const parsed = JSON.parse(storeKey) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[2] !== 'string') {
    throw new Error(`Unexpected operation key ${storeKey}.`);
  }
  return parsed[2];
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
  };
}

/** The reference journal as the reconciler's operation store. */
function adaptJournal(
  journal: CommerceConformanceJournal,
  playerId: string,
): MonetizationOperationStore {
  const toJournal = (record: CommercePurchaseOperationRecord): CommerceJournalRecord => ({
    key: record.idempotencyKey,
    revision: record.revision,
    playerId: record.playerId,
    store: record.store,
    logicalId: record.logicalId as CommerceJournalRecord['logicalId'],
    kind: record.productKind,
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
  });
  /** The operation-store fields the reference journal does not keep, by purchase key. */
  const shadows = new Map<
    string,
    Pick<CommercePurchaseOperationRecord, 'input' | 'request' | 'response'>
  >();
  const fromJournal = (record: CommerceJournalRecord): MonetizationOperationRecord => {
    const shadow = shadows.get(record.key) ?? {};
    return {
      kind: commercePurchaseOperationKind,
      key: storeKeyOf(record.key),
      playerId: record.playerId,
      target: ledgerTarget,
      deploymentTarget: ledgerTarget,
      revision: record.revision,
      idempotencyKey: record.key,
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
    };
  };
  const expectCommerce = (record: MonetizationOperationRecord): CommercePurchaseOperationRecord => {
    if (record.kind !== commercePurchaseOperationKind) {
      throw new Error(`The reconciler wrote a ${record.kind} record.`);
    }
    return record;
  };
  const shadow = (record: CommercePurchaseOperationRecord): void => {
    shadows.set(record.idempotencyKey, {
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
      const record = await journal.read(idempotencyKeyOf(key));
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
  };
}

/** The reference backend as the reconciler's verification API; the token comes from the journaled purchase. */
function adaptBackend(
  backend: CommerceConformanceBackend,
  journal: CommerceConformanceJournal,
  store: StoreId,
): PurchaseVerificationApi {
  return {
    async verifyPurchase(request) {
      const record = await journal.read(request.idempotencyKey);
      const response = await backend.verifyPurchase(
        toVerifyRequest(request, record ?? { store }),
      );
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
      return { verified: false, disposition: response.status, alreadyProcessed: false };
    },
    async getPurchaseLedgerStatus(input) {
      return { statuses: await backend.getLedgerStatus(input.ledgerEntryIds) };
    },
  };
}

const failuresByVector = new Map<string, string[]>();

function createRuntime(
  input: CreateCommerceConformanceRuntimeInput,
  context: CommerceConformanceContext,
) {
  const failures: string[] = [];
  failuresByVector.set(context.vector.vector, failures);
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
  `Commerce reconciler conformance passed: ${String(results.length)} vectors ran through createCommerceReconciler.`,
);
