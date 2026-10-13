/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CommerceProvider } from '@mpgd/platform/commerce';
import {
  createCommerceConformanceCapabilities,
  runCommerceConformanceVectors,
  type CommerceConformanceContext,
  type CommerceConformanceHarness,
  type CommerceConformanceStoreActor,
} from '@mpgd/platform/commerce-conformance';
import {
  assertCommerceConformanceVector,
  type CommerceConformanceRequestResultFixture,
  type CommerceConformanceVector,
} from '@mpgd/platform/commerce-vectors';

import { createOnePlayPlatformGateway } from './oneplay';
import {
  createOnePlayCommerceProvider,
  type OnePlayCommerceProduct,
  type OnePlayCommerceServerPort,
} from './oneplay-commerce';
import type { OnePlaySdk } from './oneplay-sdk';

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
// Wallet vectors exercise the project-owned credit wallet (B7); the ONE play
// provider has no wallet actor.
const storeVectors = vectors.filter((vector) => vector.wallet === undefined);

/**
 * Why a shared store vector cannot run against the ONE play provider, or
 * `undefined` when it can. The ONE store H5 SDK answers one call: `purchase`
 * resolves or rejects. It delivers no purchase events and lists no unfinished
 * purchases (`lifecycle.events` and `lifecycle.availablePurchases` are
 * false), so every shared vector that feeds the reconciler through a store
 * `complete`, `update`, or `error` step has no counterpart in the SDK. The
 * remaining vectors name an evidence authority other than the purchase token.
 */
export function onePlayVectorIncompatibility(vector: CommerceConformanceVector): string | undefined {
  const capabilities = createCommerceConformanceCapabilities(vector.profile);
  if (capabilities.authority.evidence !== 'client-token') {
    return `authority.evidence '${capabilities.authority.evidence}': ONE play purchases are verified `
      + 'from the purchase token and the server-issued checkout intent';
  }
  const inbound = vector.steps.find((step) => (
    step.actor === 'store' && (step.action === 'complete' || step.action === 'update' || step.action === 'error')
  ));
  if (inbound !== undefined) {
    return `store step '${inbound.action}': the ONE play SDK has no purchase events or purchase list, `
      + 'so a store-side delivery cannot be scripted';
  }
  if (vector.steps.some((step) => step.actor === 'store' && step.action === 'queueFinish')) {
    return 'store step queueFinish: the client never finishes; the backend consume or acknowledge finalizer does';
  }
  return undefined;
}

const expectedSkips: Readonly<Record<string, RegExp>> = {
  'adapter-settled': /^authority\.evidence 'adapter-settled'/u,
  'cancelled-and-failed': /^store step 'error'/u,
  'event-before-listener': /^store step 'complete'/u,
  'finish-failure-retry': /^store step 'complete'/u,
  'purchase-client-finish': /^store step 'complete'/u,
  'purchase-host-finish': /^authority\.evidence 'host-callback'/u,
  'purchase-pending-then-purchased': /^store step 'complete'/u,
  'purchase-server-finish': /^store step 'complete'/u,
  'restart-before-verify': /^store step 'complete'/u,
  'revoked-after-grant': /^store step 'complete'/u,
  'server-push-settlement': /^authority\.evidence 'server-push'/u,
};

const onePlayProfile = {
  store: 'oneplay',
  purchase: { consumable: true, durable: false, subscription: false, quantity: false },
  lifecycle: {
    availablePurchases: false,
    pending: true,
    restore: false,
    events: false,
    finish: 'server',
  },
  authority: { evidence: 'client-token', accountBinding: 'host' },
} as const;

const catalog = [{ logicalId: 'gems_small', kind: 'consumable', storeSku: 'gems.small' }] as const;
const ledger = [{ entryId: 'le-1', type: 'grant', logicalId: 'gems_small' }] as const;

/**
 * Vectors for what the SDK can do: answer the `purchase` call. They reuse the
 * shape of the shared `adapter-settled` and `cancelled-and-failed` vectors
 * (a synchronous result through the reference reconciler) with the ONE play
 * profile, so the real provider result reaches a verify request and the
 * journal the way the RFC lifecycle describes. The fake SDK maps a fixture
 * result onto the reason the real SDK rejects with.
 */
const applicableVectors: readonly CommerceConformanceVector[] = [
  assertCommerceConformanceVector({
    vector: 'oneplay-purchased-server-finish',
    protocol: '2.0.0-draft.1',
    summary: 'A purchase the SDK answers is verified from its token; the backend finalizer finishes and the client never calls finishTransaction.',
    profile: onePlayProfile,
    catalog,
    steps: [
      { actor: 'runtime', action: 'start' },
      {
        actor: 'backend',
        action: 'queueVerify',
        decision: { status: 'granted', ledgerEntryId: 'le-1', finalization: 'completed' },
      },
      {
        actor: 'store',
        action: 'queueRequest',
        result: {
          outcome: 'purchased',
          purchase: {
            transactionId: 'tx-1',
            storeSku: 'gems.small',
            token: 'token-1',
            state: 'purchased',
          },
        },
      },
      {
        actor: 'game',
        action: 'requestPurchase',
        input: { logicalId: 'gems_small', idempotencyKey: 'op-1' },
        returns: { outcome: 'purchased' },
      },
    ],
    expect: {
      journal: {
        'op-1': [
          'requested',
          'launched',
          'purchased',
          'verifying',
          'granted',
          'finishing',
          'finished',
        ],
      },
      verifyRequests: [
        { idempotencyKey: 'op-1', store: 'oneplay', transactionId: 'tx-1', token: 'token-1' },
      ],
      ledger,
      finishCalls: [],
      available: [],
      purchaseUiOpened: 1,
    },
  }),
  assertCommerceConformanceVector({
    vector: 'oneplay-cancelled-and-failed',
    protocol: '2.0.0-draft.1',
    summary: 'A cancel and a hard SDK failure each end without a verify request, and the normalized code keeps the SDK reason.',
    profile: onePlayProfile,
    catalog,
    steps: [
      { actor: 'runtime', action: 'start' },
      {
        actor: 'store',
        action: 'queueRequest',
        result: {
          outcome: 'cancelled',
          error: { code: 'USER_CANCELLED', retryable: false, storeCode: 'user_cancelled' },
        },
      },
      {
        actor: 'game',
        action: 'requestPurchase',
        input: { logicalId: 'gems_small', idempotencyKey: 'op-1' },
        returns: {
          outcome: 'cancelled',
          error: { code: 'USER_CANCELLED', storeCode: 'user_cancelled', retryable: false },
        },
      },
      {
        actor: 'store',
        action: 'queueRequest',
        result: {
          outcome: 'failed',
          error: {
            code: 'STORE_UNAVAILABLE',
            retryable: false,
            storeCode: 'platform_not_supported',
          },
        },
      },
      {
        actor: 'game',
        action: 'requestPurchase',
        input: { logicalId: 'gems_small', idempotencyKey: 'op-2' },
        returns: {
          outcome: 'failed',
          error: {
            code: 'STORE_UNAVAILABLE',
            storeCode: 'platform_not_supported',
            retryable: false,
          },
        },
      },
    ],
    expect: {
      journal: { 'op-1': ['requested', 'cancelled'], 'op-2': ['requested', 'failed'] },
      verifyRequests: [],
      ledger: [],
      finishCalls: [],
      available: [],
      purchaseUiOpened: 2,
    },
  }),
  assertCommerceConformanceVector({
    vector: 'oneplay-unknown-outcome',
    protocol: '2.0.0-draft.1',
    summary: 'A timeout or transport failure keeps the attempt launched: nothing is verified, granted, or finished from it.',
    profile: onePlayProfile,
    catalog,
    steps: [
      { actor: 'runtime', action: 'start' },
      {
        actor: 'store',
        action: 'queueRequest',
        result: { outcome: 'launched' },
      },
      {
        actor: 'game',
        action: 'requestPurchase',
        input: { logicalId: 'gems_small', idempotencyKey: 'op-1' },
        returns: { outcome: 'launched' },
      },
    ],
    expect: {
      journal: { 'op-1': ['requested', 'launched'] },
      verifyRequests: [],
      ledger: [],
      finishCalls: [],
      available: [],
      purchaseUiOpened: 1,
    },
  }),
];

/** The SDK reason that yields a fixture error; the fixture names it as the `storeCode`. */
function sdkReasonOf(result: Extract<CommerceConformanceRequestResultFixture, { error: unknown }>): string {
  return result.error.storeCode ?? 'payment_failed';
}

/**
 * Translates the vector's `store` steps into a fake ONE play SDK the way the
 * host behaves: a scripted `purchased` result resolves the `purchase` call
 * with the fixture ids, a cancel or failure rejects with the SDK reason, and
 * an unscripted or `launched` call rejects with a timeout. The server port
 * issues a deterministic checkout intent per idempotency key.
 */
function createOnePlayConformance(context: CommerceConformanceContext): {
  readonly sdk: OnePlaySdk;
  readonly products: readonly OnePlayCommerceProduct[];
  readonly server: OnePlayCommerceServerPort;
  readonly actor: CommerceConformanceStoreActor;
} {
  const requestQueue: CommerceConformanceRequestResultFixture[] = [];
  let purchaseUiOpened = 0;
  const fixtureSdk = createBaseSdk();
  const sdk: OnePlaySdk = {
    ...fixtureSdk,
    iap: {
      isSupported: () => true,
      async getProductDetailsAsync() {
        return [];
      },
      async purchase(input) {
        purchaseUiOpened += 1;
        const queued = requestQueue.shift() ?? { outcome: 'launched' };
        if (queued.outcome === 'purchased') {
          return {
            orderId: `order-${queued.purchase.transactionId}`,
            purchaseTimeMillis: 1,
            purchaseId: queued.purchase.transactionId,
            purchaseToken: queued.purchase.token,
            productId: input.productId,
            developerPayload: input.developerPayload,
          };
        }
        if (queued.outcome === 'launched') {
          throw { reason: 'timeout' };
        }
        throw { reason: sdkReasonOf(queued) };
      },
    },
  };
  const products = context.catalog.map((entry): OnePlayCommerceProduct => {
    if (entry.kind === 'subscription') {
      throw new Error(
        `The ONE play H5 SDK sells one-time products only; ${entry.logicalId} cannot be mapped.`,
      );
    }
    return {
      id: entry.logicalId,
      platformId: entry.storeSku,
      type: entry.kind === 'consumable' ? 'consumable' : 'non_consumable',
    };
  });
  const server: OnePlayCommerceServerPort = {
    async issueIntent(input) {
      return { developerPayload: `intent:${input.idempotencyKey}` };
    },
  };
  const unsupported = (action: string): never => {
    throw new Error(`The ONE play SDK has no ${action}; only the purchase call answers.`);
  };
  const actor: CommerceConformanceStoreActor = {
    get purchaseUiOpened() {
      return purchaseUiOpened;
    },
    get finishCalls() {
      // lifecycle.finish is 'server': the client has no finish surface at all.
      return [];
    },
    complete: () => unsupported('purchase events'),
    update: () => unsupported('purchase events'),
    error: () => unsupported('purchase error events'),
    queueRequest(result) {
      requestQueue.push(result);
    },
    queueFinish: () => unsupported('client finish'),
  };
  return { sdk, products, server, actor };
}

function createBaseSdk(): OnePlaySdk {
  return {
    async initializeAsync() {
      return {
        playerId: 'platform-player',
        locale: 'en-US',
        ringerSilent: false,
        safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
      };
    },
    setLoadingProgress() {},
    async startGameAsync() {
      return {};
    },
    on() {},
    off() {},
    onBackPressed() {},
    ads: {
      isSupported: () => false,
      loadRewarded() {},
      loadInterstitial() {},
      async isReadyAsync() {
        return false;
      },
      async showRewardedAsync() {
        return { status: 'failed' as const };
      },
      async showInterstitialAsync() {
        return { status: 'failed' as const };
      },
    },
  };
}

function createVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const { sdk, products, server, actor } = createOnePlayConformance(context);
  return { provider: createOnePlayCommerceProvider({ sdk, products, server }), store: actor };
}

/** The provider the ONE play gateway installs, which is the only commerce surface a game sees. */
async function createGatewayVectorProvider(
  context: CommerceConformanceContext,
): Promise<CommerceConformanceHarness> {
  const { sdk, products, server, actor } = createOnePlayConformance(context);
  const gateway = await createOnePlayPlatformGateway({ sdk, products, commerceServer: server });
  if (gateway.commerce === undefined) {
    throw new Error('The ONE play gateway must install its commerce provider.');
  }
  return { provider: gateway.commerce, store: actor };
}

describe('ONE play commerce provider conformance', () => {
  it('classifies every shared store vector against the oneplay profile', () => {
    expect(storeVectors).toHaveLength(11);
    const skipped = Object.fromEntries(storeVectors.flatMap((vector) => {
      const reason = onePlayVectorIncompatibility(vector);
      return reason === undefined ? [] : [[vector.vector, reason]];
    }));
    expect(Object.keys(skipped).sort()).toEqual(Object.keys(expectedSkips).sort());
    for (const [vector, pattern] of Object.entries(expectedSkips)) {
      expect(skipped[vector], vector).toMatch(pattern);
    }
  });

  it('declares the same profile the applicable vectors are written for', async () => {
    const context = { catalog } as unknown as CommerceConformanceContext;
    const { sdk, products, server } = createOnePlayConformance(context);
    const provider = createOnePlayCommerceProvider({ sdk, products, server });
    const declared = await provider.getCapabilities();
    const fromProfile = createCommerceConformanceCapabilities(onePlayProfile);
    // The catalog flags are the provider's own; the lifecycle the vectors depend on must match.
    expect(declared.purchase).toEqual(fromProfile.purchase);
    expect(declared.lifecycle).toEqual(fromProfile.lifecycle);
    expect(declared.authority).toEqual(fromProfile.authority);
    expect(declared.availability).toBe('available');
  });

  it('passes every applicable vector against the fake ONE play SDK', async () => {
    const results = await runCommerceConformanceVectors(applicableVectors, {
      createProvider: createVectorProvider,
    });
    expect(results.map((result) => ({
      vector: result.vector, passed: result.passed, failures: result.failures,
    }))).toEqual(applicableVectors.map((vector) => ({
      vector: vector.vector, passed: true, failures: [],
    })));
  });

  it('passes every applicable vector through a gateway-installed provider', async () => {
    const results = await runCommerceConformanceVectors(applicableVectors, {
      createProvider: createGatewayVectorProvider,
    });
    expect(results.map((result) => ({
      vector: result.vector, passed: result.passed, failures: result.failures,
    }))).toEqual(applicableVectors.map((vector) => ({
      vector: vector.vector, passed: true, failures: [],
    })));
  });

  it('fails an applicable vector whose expectation the provider cannot meet', async () => {
    const vector = applicableVectors.find((candidate) => candidate.vector === 'oneplay-purchased-server-finish');
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
