import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { CommerceProvider } from '@mpgd/platform/commerce';
import {
  isAdaptiveCommerceConformanceVector,
  runCommerceConformanceVectors,
  type CommerceConformanceContext,
  type CommerceConformanceFinishCall,
  type CommerceConformanceHarness,
  type CommerceConformanceStoreActor,
  type CommerceConformanceVectorResult,
} from '@mpgd/platform/commerce-conformance';
import {
  assertCommerceConformanceVector,
  type CommerceConformancePurchaseFixture,
  type CommerceConformanceVector,
} from '@mpgd/platform/commerce-vectors';

import {
  assertEqual,
  createFakeStoreKitPlugin,
  fakeAccountToken,
  type FakeStoreKitPlugin,
} from '../test/fake-storekit-plugin.js';
import {
  createCapacitorStoreKitCommerceProvider,
  createCapacitorStoreKitServiceProvider,
} from './commerce-provider.js';
import type { StoreKitTransaction } from './definitions.js';
import { storeKitStoreSdkCapabilities } from './store-sdk.js';

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
const allVectors: readonly CommerceConformanceVector[] = readdirSync(vectorsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => assertCommerceConformanceVector(
    JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown,
  ));

/**
 * Why a vector cannot be handed to the runner for the StoreKit provider. An
 * adaptive vector (`profile.adaptive`) is matched against expectations the
 * runner derives from the StoreKit capabilities and the `app-store` id, so
 * only a step the plugin has no surface for rules it out here: StoreKit
 * reports no purchase error events, and a StoreKit transaction is never in
 * state `pending` (Ask to Buy answers with a pending purchase result and no
 * transaction), even though the provider declares `lifecycle.pending`. A
 * profile-specific vector is compared against expectations written for its
 * fixture profile, so that profile must match StoreKit's.
 */
function skipReason(vector: CommerceConformanceVector): string | undefined {
  if (vector.wallet !== undefined) {
    return 'wallet vector: the project-owned credit wallet (B7), no store SDK';
  }
  if (vector.steps.some((step) => step.actor === 'store' && step.action === 'error')) {
    return 'vector emits an asynchronous store error event; StoreKit reports no purchase error '
      + 'events (a declined Ask to Buy never produces a transaction)';
  }
  if (vector.steps.some((step) => step.actor === 'store'
    && (step.action === 'complete' || step.action === 'update')
    && step.purchase.state === 'pending')) {
    return 'vector reports a pending transaction; StoreKit answers Ask to Buy with a pending '
      + 'purchase result and no transaction, so a transaction is never in state pending';
  }
  if (isAdaptiveCommerceConformanceVector(vector)) {
    return undefined;
  }
  const profile = vector.profile;
  const purchase = profile.purchase;
  const lifecycle = profile.lifecycle;
  const authority = profile.authority;
  if (purchase?.subscription === true) {
    return 'profile sells subscriptions; StoreKit subscriptions are out of scope (RFC D-02)';
  }
  if (purchase?.quantity === true) {
    return 'profile supports quantity; StoreKit sells one unit per transaction';
  }
  if (lifecycle !== undefined && lifecycle.finish !== storeKitStoreSdkCapabilities.finish) {
    return `profile finishes by '${lifecycle.finish}'; StoreKit finishes on the client after the ledger grant`;
  }
  if (lifecycle?.availablePurchases === false) {
    return 'profile lists no available purchases; StoreKit lists unfinished transactions';
  }
  if (authority !== undefined && authority.evidence !== 'client-token') {
    return `profile evidence is '${authority.evidence}'; StoreKit evidence is the client JWS token`;
  }
  return undefined;
}

const skipped: { readonly vector: string; readonly reason: string }[] = [];
const runnable: CommerceConformanceVector[] = [];
for (const vector of allVectors) {
  const reason = skipReason(vector);
  if (reason === undefined) {
    runnable.push(vector);
  } else {
    skipped.push({ vector: vector.vector, reason });
  }
}

interface ConformancePlugin {
  readonly plugin: FakeStoreKitPlugin;
  readonly actor: CommerceConformanceStoreActor;
}

/**
 * Translates the vector's `store` steps into the fake StoreKit plugin:
 * `complete` and `update` push a transaction and emit `transactionUpdated`,
 * `queueRequest` scripts the native `purchase` answer (a `purchased` result
 * is a transaction, a `cancelled` one the cancelled status, a `failed` one
 * a thrown plugin error), `queueFinish` scripts `finishTransaction`, and the
 * actor observes the purchase sheet and the finish calls the client makes.
 */
function createConformancePlugin(context: CommerceConformanceContext): ConformancePlugin {
  const plugin = createFakeStoreKitPlugin({
    products: context.catalog.map((entry) => ({
      productId: entry.storeSku,
      type: entry.kind === 'consumable' ? 'consumable' : 'non_consumable',
      title: entry.logicalId,
      description: `Fixture product ${entry.storeSku}`,
      formattedPrice: '$0.99',
      currencyCode: 'USD',
    })),
  });
  const kindOf = (storeSku: string): 'consumable' | 'non_consumable' =>
    context.catalog.find((entry) => entry.storeSku === storeSku)?.kind === 'consumable'
      ? 'consumable'
      : 'non_consumable';
  const toTransaction = (fixture: CommerceConformancePurchaseFixture): StoreKitTransaction => ({
    transactionId: fixture.transactionId,
    originalTransactionId: fixture.originalTransactionId ?? fixture.transactionId,
    productId: fixture.storeSku,
    type: kindOf(fixture.storeSku),
    appAccountToken: fakeAccountToken,
    purchasedAt: fixture.purchasedAt ?? '2026-10-01T00:00:00Z',
    // The fixture token is the signed transaction JWS the SDK forwards verbatim.
    signedTransaction: fixture.token,
    ...(fixture.state === 'revoked' ? { revokedAt: '2026-10-02T00:00:00Z' } : {}),
    unfinished: true,
  });
  const finishCalls: CommerceConformanceFinishCall[] = [];
  const finish = plugin.finishTransaction;
  plugin.finishTransaction = async (input) => {
    const transaction = plugin.transactions.find(
      (entry) => entry.transactionId === input.transactionId,
    );
    const call = {
      by: 'client' as const,
      transactionId: input.transactionId,
      ledgerEntryId: input.ledgerEntryId,
      isConsumable: transaction?.type === 'consumable',
    };
    try {
      const result = await finish.call(plugin, input);
      finishCalls.push({ ...call, result: result.finished ? 'finished' : 'unfinished' });
      return result;
    } catch (error) {
      finishCalls.push({
        ...call,
        result: (error as { readonly code: CommerceConformanceFinishCall['result'] }).code,
      });
      throw error;
    }
  };
  const report = (fixture: CommerceConformancePurchaseFixture): void => {
    plugin.report(toTransaction(fixture));
  };
  const actor: CommerceConformanceStoreActor = {
    get purchaseUiOpened() {
      return plugin.calls.filter((call) => call.startsWith('purchase:')).length;
    },
    get finishCalls() {
      return [...finishCalls];
    },
    complete: report,
    update: report,
    error() {
      throw new Error('StoreKit reports no asynchronous purchase errors; the vector is skipped.');
    },
    queueRequest(result) {
      if (result.outcome === 'launched') {
        plugin.queuePurchase({ status: 'pending' });
      } else if (result.outcome === 'purchased') {
        plugin.queuePurchase({ status: 'purchased', transaction: toTransaction(result.purchase) });
      } else if (result.error.code === 'USER_CANCELLED') {
        plugin.queuePurchase({ status: 'cancelled' });
      } else {
        plugin.queuePurchase({
          throws: Object.assign(new Error(`Fixture failure ${result.error.code}.`), {
            code: result.error.code,
            retryable: result.error.retryable,
            ...(result.error.storeCode === undefined ? {} : { storeCode: result.error.storeCode }),
          }),
        });
      }
    },
    queueFinish(result) {
      plugin.queueFinish(
        'error' in result
          ? { throws: Object.assign(new Error('Fixture finish failure.'), { code: result.error }) }
          : { finished: result.finished },
      );
    },
    finalize(request) {
      plugin.remove(request.transactionId);
    },
  };
  return { plugin, actor };
}

function providerInput(context: CommerceConformanceContext, plugin: FakeStoreKitPlugin) {
  return {
    products: context.catalog.map((entry) => ({
      logicalId: entry.logicalId,
      storeSku: entry.storeSku,
      kind: entry.kind,
    })),
    getAppAccountToken: () => fakeAccountToken,
    bundleId: 'com.example.game',
    sdk: plugin,
    isIos: () => true,
  };
}

function createVectorProvider(context: CommerceConformanceContext): {
  readonly provider: CommerceProvider;
  readonly store: CommerceConformanceStoreActor;
} {
  const { plugin, actor } = createConformancePlugin(context);
  return {
    provider: createCapacitorStoreKitCommerceProvider(providerInput(context, plugin)),
    store: actor,
  };
}

function createBridgedVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const { plugin, actor } = createConformancePlugin(context);
  const gateway = createCapacitorPlatformGateway({
    target: 'ios',
    appVersion: '1.0.0',
    buildId: `conformance:${context.vector.vector}`,
    bridge: {
      async request(input: BridgeRequest): Promise<BridgeResponse> {
        throw new Error(`The base bridge must not receive ${input.method}.`);
      },
    },
    providers: [createCapacitorStoreKitServiceProvider(providerInput(context, plugin))],
  });
  if (gateway.commerce === undefined) {
    throw new Error('The gateway must expose the registered StoreKit commerce provider.');
  }
  return { provider: gateway.commerce, store: actor };
}

function summarize(results: readonly CommerceConformanceVectorResult[]) {
  return results.map((result) => ({
    vector: result.vector,
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.failures.length === 0 ? {} : { failures: result.failures }),
  }));
}

assertEqual(
  skipped,
  [
    {
      vector: 'adapter-settled',
      reason: "profile finishes by 'server'; StoreKit finishes on the client after the ledger grant",
    },
    {
      vector: 'cancelled-and-failed',
      reason: 'vector emits an asynchronous store error event; StoreKit reports no purchase error '
        + 'events (a declined Ask to Buy never produces a transaction)',
    },
    {
      vector: 'credit-lot-title-scope',
      reason: 'wallet vector: the project-owned credit wallet (B7), no store SDK',
    },
    {
      vector: 'credit-membership-renewal',
      reason: 'wallet vector: the project-owned credit wallet (B7), no store SDK',
    },
    {
      vector: 'membership-store-billing-target',
      reason: 'wallet vector: the project-owned credit wallet (B7), no store SDK',
    },
    {
      vector: 'purchase-pending-then-purchased',
      reason: 'vector reports a pending transaction; StoreKit answers Ask to Buy with a pending '
        + 'purchase result and no transaction, so a transaction is never in state pending',
    },
    {
      vector: 'server-push-settlement',
      reason: "profile finishes by 'none'; StoreKit finishes on the client after the ledger grant",
    },
  ],
  'the skipped vectors and their reasons are listed',
);
assertEqual(
  runnable.map((vector) => vector.vector),
  [
    'event-before-listener',
    'finish-failure-retry',
    'purchase-client-finish',
    'purchase-host-finish',
    'purchase-server-finish',
    'restart-before-verify',
    'revoked-after-grant',
  ],
  'every other store vector is handed to the runner',
);
assertEqual(
  runnable.every(isAdaptiveCommerceConformanceVector),
  true,
  'every vector handed to the runner is adaptive',
);
assertEqual(allVectors.length, skipped.length + runnable.length, 'every vector is classified');

/**
 * What the runner reports under StoreKit's declared `finish: 'client'`: the
 * two other members of the `purchase-<owner>-finish` family are duplicates of
 * `purchase-client-finish`, and the rest run with client-finish expectations
 * derived for the `app-store` id.
 */
const expectedStatuses = [
  { vector: 'event-before-listener', status: 'passed' },
  { vector: 'finish-failure-retry', status: 'passed' },
  { vector: 'purchase-client-finish', status: 'passed' },
  {
    vector: 'purchase-host-finish',
    status: 'skipped',
    reason: "duplicate of purchase-client-finish for finish='client'",
  },
  {
    vector: 'purchase-server-finish',
    status: 'skipped',
    reason: "duplicate of purchase-client-finish for finish='client'",
  },
  { vector: 'restart-before-verify', status: 'passed' },
  { vector: 'revoked-after-grant', status: 'passed' },
] as const;

const direct = await runCommerceConformanceVectors(runnable, {
  createProvider: createVectorProvider,
});
assertEqual(
  summarize(direct),
  [...expectedStatuses],
  'every runnable vector passes against the StoreKit provider over the fake plugin',
);

const bridged = await runCommerceConformanceVectors(runnable, {
  createProvider: createBridgedVectorProvider,
});
assertEqual(
  summarize(bridged),
  [...expectedStatuses],
  'every runnable vector passes through the gateway bridge path',
);

// The derived expectations prove the client finished with the ledger entry id,
// under the `app-store` id the provider reports rather than the fixture's.
for (const result of [...direct, ...bridged]) {
  if (result.status !== 'passed') {
    continue;
  }
  const adaptive = result.adaptive;
  if (adaptive === undefined) {
    throw new Error(`${result.vector} did not run adaptively.`);
  }
  assertEqual(adaptive.store, 'app-store', `${result.vector} derived for the app-store id`);
  assertEqual(adaptive.finish, 'client', `${result.vector} derived for the client finish owner`);
  assertEqual(
    adaptive.evidence,
    'client-token',
    `${result.vector} derived for client-token evidence`,
  );
  const finishCalls = adaptive.expect.finishCalls ?? [];
  assertEqual(finishCalls.length > 0, true, `${result.vector} expects client finish calls`);
  assertEqual(
    finishCalls.every((call) => call.by === 'client' && call.ledgerEntryId.length > 0),
    true,
    `${result.vector} expects client finish calls carrying the ledger entry id`,
  );
  assertEqual(
    (adaptive.expect.verifyRequests ?? []).every((request) => request.store === 'app-store'),
    true,
    `${result.vector} expects verify requests for the app-store id`,
  );
  assertEqual(adaptive.expect.available, [], `${result.vector} expects no unfinished transaction`);
}
assertEqual(
  Object.keys(
    direct.find((result) => result.vector === 'event-before-listener')?.adaptive?.expect.journal ?? {},
  ),
  ['store:app-store:tx-1'],
  'the derived key carries the app-store id',
);
assertEqual(
  direct.find((result) => result.vector === 'finish-failure-retry')?.adaptive?.expect.finishCalls
    ?.map((call) => call.result),
  ['NETWORK', 'finished'],
  'the finish retry keeps the failed and the retried client finish',
);

// A changed expectation fails, so the pass above is a real check.
{
  const vector = runnable.find((candidate) => candidate.vector === 'purchase-client-finish');
  if (vector === undefined) {
    throw new Error('Missing vector.');
  }
  const [result] = await runCommerceConformanceVectors(
    [{ ...vector, expect: { ...vector.expect, purchaseUiOpened: 99 } }],
    { createProvider: createVectorProvider },
  );
  assertEqual(result?.status, 'failed', 'a wrong expectation fails');
  assertEqual(
    result?.failures,
    [{ path: 'purchaseUiOpened', expected: 99, actual: 1 }],
    'the purchase sheet opened once',
  );
}

// A family member run on its own is not a duplicate and passes with the same derivation.
{
  const vector = runnable.find((candidate) => candidate.vector === 'purchase-server-finish');
  if (vector === undefined) {
    throw new Error('Missing vector.');
  }
  const [result] = await runCommerceConformanceVectors([vector], {
    createProvider: createVectorProvider,
  });
  assertEqual(
    result?.failures,
    [],
    'purchase-server-finish passes alone with client-finish expectations',
  );
  assertEqual(result?.status, 'passed', 'purchase-server-finish is not a duplicate on its own');
  assertEqual(
    result?.adaptive?.expect.finishCalls?.map((call) => call.by),
    ['client'],
    'the server-finish fixture is finished by the StoreKit client',
  );
  assertEqual(
    result?.adaptive?.expect.verifyRequests?.length,
    1,
    'no finalization re-read for a client finish owner',
  );
}

const ran = direct.filter((result) => result.status === 'passed').length;
console.info(
  `StoreKit commerce v2 conformance passed: ${String(ran)} vectors ran, `
    + `${String(runnable.length - ran)} runner-skipped, ${String(skipped.length)} pre-skipped.`,
);
