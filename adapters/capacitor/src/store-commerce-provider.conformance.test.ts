import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import type { CommerceProvider, StorePurchaseAccountBinding } from '@mpgd/platform/commerce';
import {
  createCommerceConformanceCapabilities,
  runCommerceConformanceVectors,
  type CommerceConformanceContext,
  type CommerceConformanceFinishCall,
  type CommerceConformanceHarness,
  type CommerceConformanceStoreActor,
} from '@mpgd/platform/commerce-conformance';
import {
  assertCommerceConformanceVector,
  type CommerceConformanceErrorFixture,
  type CommerceConformancePurchaseFixture,
  type CommerceConformanceVector,
} from '@mpgd/platform/commerce-vectors';

import { createFakeStoreSdk, type FakeStoreSdk } from '../test/store-sdk-fixture.js';
import { createCommerceServiceProvider } from './commerce-bridge.js';
import { createCapacitorPlatformGateway } from './index.js';
import { createStoreCommerceProvider } from './store-commerce-provider.js';
import type { StoreSdkError, StoreSdkPurchase } from './store-sdk.js';

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
// Wallet vectors exercise the project-owned credit wallet (B7); a store SDK
// provider has no wallet actor, so they stay on the reference harness.
const storeVectors = vectors.filter((vector) => vector.wallet === undefined);

interface ConformanceStoreSdk {
  readonly sdk: FakeStoreSdk;
  readonly actor: CommerceConformanceStoreActor;
  readonly accountBinding: StorePurchaseAccountBinding | undefined;
}

/**
 * Translates the vector's `store` steps into the fake `StoreSdk`: scripted
 * answers become SDK results or thrown SDK errors, reported purchases become
 * SDK purchases plus `purchaseUpdated` events, and the actor observes the
 * SDK's purchase UI and finish calls.
 */
function createConformanceStoreSdk(context: CommerceConformanceContext): ConformanceStoreSdk {
  const capabilities = createCommerceConformanceCapabilities(context.profile);
  const accountBinding = fixtureAccountBinding(context);
  const sdk = createFakeStoreSdk({
    store: context.profile.store,
    capabilities: {
      purchase: capabilities.purchase,
      offers: capabilities.catalog.offers,
      pending: capabilities.lifecycle.pending,
      restore: capabilities.lifecycle.restore,
      finish: capabilities.lifecycle.finish,
    },
    products: context.catalog.map((entry) => ({
      sku: entry.storeSku,
      kind: entry.kind,
      title: entry.logicalId,
      description: `Fixture product ${entry.storeSku}`,
      price: { formatted: '$0.99', currencyCode: 'USD', amountMicros: 990_000 },
    })),
  });
  const finishCalls: CommerceConformanceFinishCall[] = [];
  const toSdkPurchase = (fixture: CommerceConformancePurchaseFixture): StoreSdkPurchase => ({
    sku: fixture.storeSku,
    transactionId: fixture.transactionId,
    ...(fixture.originalTransactionId === undefined
      ? {}
      : { originalTransactionId: fixture.originalTransactionId }),
    state: fixture.state,
    ...(fixture.purchasedAt === undefined ? {} : { purchasedAt: fixture.purchasedAt }),
    token: fixture.token,
    quantity: 1,
    ...(accountBinding === undefined ? {} : { accountBinding }),
    // A fixture `settlement` is never copied: the provider does not settle.
  });
  const toSdkError = (fixture: CommerceConformanceErrorFixture): StoreSdkError => ({
    code: fixture.code,
    retryable: fixture.retryable,
    ...(fixture.storeCode === undefined ? {} : { storeCode: fixture.storeCode }),
  });
  const skuOf = (logicalId: string | undefined): string | undefined =>
    context.catalog.find((entry) => entry.logicalId === logicalId)?.storeSku;
  const by = capabilities.lifecycle.finish === 'host' ? 'host' : 'client';
  const finish = sdk.finishTransaction;
  if (finish !== undefined) {
    sdk.finishTransaction = async (input) => {
      try {
        const result = await finish.call(sdk, input);
        finishCalls.push({
          by,
          transactionId: input.transactionId,
          ledgerEntryId: input.ledgerEntryId,
          isConsumable: input.isConsumable,
          result: result.finished ? 'finished' : 'unfinished',
        });
        return result;
      } catch (error) {
        finishCalls.push({
          by,
          transactionId: input.transactionId,
          ledgerEntryId: input.ledgerEntryId,
          isConsumable: input.isConsumable,
          result: (error as StoreSdkError).code as CommerceConformanceFinishCall['result'],
        });
        throw error;
      }
    };
  }
  const report = (fixture: CommerceConformancePurchaseFixture): void => {
    sdk.report(toSdkPurchase(fixture));
  };
  const actor: CommerceConformanceStoreActor = {
    get purchaseUiOpened() {
      return sdk.requestCalls.length;
    },
    get finishCalls() {
      return [...finishCalls];
    },
    complete: report,
    update: report,
    error(event) {
      const sku = skuOf(event.logicalId);
      sdk.emit({
        type: 'purchaseError',
        ...(sku === undefined ? {} : { sku }),
        error: toSdkError(event.error),
      });
    },
    queueRequest(result) {
      if (result.outcome === 'launched') {
        sdk.queueRequest({ outcome: 'launched' });
      } else if (result.outcome === 'purchased') {
        sdk.queueRequest({ outcome: 'purchased', purchase: toSdkPurchase(result.purchase) });
      } else {
        // Thrown, not returned: the provider must classify a thrown cancel as `cancelled`.
        sdk.queueRequest({ throws: toSdkError(result.error) });
      }
    },
    queueFinish(result) {
      sdk.queueFinish('error' in result
        ? { throws: { code: result.error, message: 'Fixture finish failure.' } }
        : { finished: result.finished });
    },
    finalize(request) {
      sdk.remove(request.transactionId);
    },
  };
  return { sdk, actor, accountBinding };
}

function fixtureAccountBinding(
  context: CommerceConformanceContext,
): StorePurchaseAccountBinding | undefined {
  switch (context.profile.authority?.accountBinding ?? 'optional') {
    case 'required':
      return { kind: 'obfuscated-account-id', value: context.playerId };
    case 'host':
      return { kind: 'host-identity' };
    case 'optional':
      return undefined;
  }
}

function createVectorProvider(context: CommerceConformanceContext): {
  readonly provider: CommerceProvider;
  readonly store: CommerceConformanceStoreActor;
} {
  const capabilities = createCommerceConformanceCapabilities(context.profile);
  const { sdk, actor, accountBinding } = createConformanceStoreSdk(context);
  const provider = createStoreCommerceProvider({
    sdk,
    products: context.catalog.map((entry) => ({
      logicalId: entry.logicalId,
      storeSku: entry.storeSku,
      kind: entry.kind,
    })),
    evidenceSchema: `fixture.${context.profile.store}.v1`,
    evidencePayload: (purchase) => ({ token: purchase.token }),
    accountBinding: async () => accountBinding,
    capabilities: { lifecycle: capabilities.lifecycle },
    authority: capabilities.authority,
  });
  return { provider, store: actor };
}

function createBridgedVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const { provider, store } = createVectorProvider(context);
  const gateway = createCapacitorPlatformGateway({
    target: 'android',
    appVersion: '1.0.0',
    buildId: `conformance:${context.vector.vector}`,
    bridge: {
      async request(input: BridgeRequest): Promise<BridgeResponse> {
        throw new Error(`The base bridge must not receive ${input.method}.`);
      },
    },
    providers: [createCommerceServiceProvider({ id: 'store', commerce: provider })],
  });
  if (gateway.commerce === undefined) {
    throw new Error('The gateway must expose the registered commerce provider.');
  }
  return { provider: gateway.commerce, store };
}

describe('store commerce provider conformance', () => {
  it('runs every store vector against the fake StoreSdk', async () => {
    expect(storeVectors).toHaveLength(11);
    const results = await runCommerceConformanceVectors(storeVectors, {
      createProvider: createVectorProvider,
    });
    expect(results.map((result) => ({
      vector: result.vector, passed: result.passed, failures: result.failures,
    }))).toEqual(storeVectors.map((vector) => ({
      vector: vector.vector, passed: true, failures: [],
    })));
  });

  it('runs every store vector through the gateway bridge path', async () => {
    const results = await runCommerceConformanceVectors(storeVectors, {
      createProvider: createBridgedVectorProvider,
    });
    expect(results.map((result) => ({
      vector: result.vector, passed: result.passed, failures: result.failures,
    }))).toEqual(storeVectors.map((vector) => ({
      vector: vector.vector, passed: true, failures: [],
    })));
  });

  it('keeps the wallet vectors on the reference harness', async () => {
    const walletVectors = vectors.filter((vector) => vector.wallet !== undefined);
    expect(walletVectors).toHaveLength(3);
    const results = await runCommerceConformanceVectors(walletVectors);
    expect(results.every((result) => result.passed)).toBe(true);
  });

  it('fails a vector whose expectation the SDK provider cannot meet', async () => {
    const vector = storeVectors.find((candidate) => candidate.vector === 'purchase-client-finish');
    if (vector === undefined) {
      throw new Error('Missing vector.');
    }
    const [result] = await runCommerceConformanceVectors(
      [{ ...vector, expect: { ...vector.expect, purchaseUiOpened: 99 } }],
      { createProvider: createVectorProvider },
    );
    expect(result?.passed).toBe(false);
    expect(result?.failures).toEqual([{ path: 'purchaseUiOpened', expected: 99, actual: 1 }]);
  });
});
