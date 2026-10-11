/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PlatformGateway } from '@mpgd/platform';
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
  type CommerceConformanceProfile,
  type CommerceConformancePurchaseFixture,
  type CommerceConformanceRequestResultFixture,
  type CommerceConformanceVector,
} from '@mpgd/platform/commerce-vectors';

import { createBrowserPlatformGateway } from './index';
import {
  createMicrosoftStoreCommerceProvider,
  withMicrosoftStoreCommerceProvider,
  type MicrosoftStoreCommerceProduct,
  type MicrosoftStoreDigitalGoodsPurchase,
  type MicrosoftStorePaymentResponse,
  type MicrosoftStorePurchaseAuthority,
  type MicrosoftStoreRecoveryAuthorityInput,
} from './microsoft-store';

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
// Wallet vectors exercise the project-owned credit wallet (B7); the Store
// provider has no wallet actor, so they stay on the reference harness.
const storeVectors = vectors.filter((vector) => vector.wallet === undefined);

/**
 * Why the Microsoft Store provider cannot serve a vector profile, or
 * `undefined` when it can. The runner drives whatever provider
 * `createProvider` returns against expectations written for the vector's
 * profile, so a profile whose finish owner, evidence authority, product
 * kinds, or pending state differ from the Digital Goods path would fail on
 * those expectations rather than be reported as not applicable.
 */
export function microsoftStoreVectorIncompatibility(
  profile: CommerceConformanceProfile,
): string | undefined {
  const capabilities = createCommerceConformanceCapabilities(profile);
  if (capabilities.lifecycle.finish !== 'server') {
    return `lifecycle.finish '${capabilities.lifecycle.finish}': the backend consume finalizer `
      + 'finishes Microsoft Store purchases; the client never calls finishTransaction';
  }
  if (capabilities.authority.evidence !== 'adapter-settled') {
    return `authority.evidence '${capabilities.authority.evidence}': the Microsoft Store adapter `
      + 'settles with the game-owned authority before requestPurchase returns';
  }
  if (capabilities.purchase.durable || capabilities.purchase.subscription) {
    return 'purchase.durable/subscription: Digital Goods sells developer-managed consumables only';
  }
  if (capabilities.lifecycle.pending) {
    return 'lifecycle.pending: Microsoft Store has no store-side pending state';
  }
  if (!capabilities.lifecycle.availablePurchases) {
    return 'lifecycle.availablePurchases false: listPurchases always lists unconsumed purchases';
  }
  return undefined;
}

const expectedSkips: Readonly<Record<string, RegExp>> = {
  'cancelled-and-failed': /^lifecycle\.finish 'client'/u,
  'event-before-listener': /^lifecycle\.finish 'client'/u,
  'finish-failure-retry': /^lifecycle\.finish 'client'/u,
  'purchase-client-finish': /^lifecycle\.finish 'client'/u,
  'purchase-host-finish': /^lifecycle\.finish 'host'/u,
  'purchase-pending-then-purchased': /^lifecycle\.finish 'client'/u,
  'purchase-server-finish': /^authority\.evidence 'client-token'/u,
  'restart-before-verify': /^lifecycle\.finish 'client'/u,
  'revoked-after-grant': /^lifecycle\.finish 'client'/u,
  'server-push-settlement': /^lifecycle\.finish 'none'/u,
};
const microsoftStoreVectors = storeVectors.filter(
  (vector) => microsoftStoreVectorIncompatibility(vector.profile) === undefined,
);

interface ConformanceDigitalGoods {
  readonly provider: CommerceProvider;
  readonly actor: CommerceConformanceStoreActor;
}

function purchaseIdentity(purchase: MicrosoftStoreDigitalGoodsPurchase): string {
  return JSON.stringify([purchase.itemId, purchase.purchaseToken]);
}

/**
 * Translates the vector's `store` steps into a fake Digital Goods service, a
 * fake Payment Request, and a fake purchase authority the way the Store
 * behaves: a scripted `purchased` result resolves Payment Request with the
 * fixture token, lists `{ itemId: storeSku, purchaseToken: token }`, and
 * scripts the authority to grant the fixture's `settlement` ledger entry; a
 * `complete` step lists the purchase for the next `getAvailablePurchases`
 * (Digital Goods has no purchase event); the backend finalizer removes a
 * consumed purchase from the list; the client never finishes.
 */
function createConformanceDigitalGoods(
  context: CommerceConformanceContext,
  install: (provider: ReturnType<typeof createMicrosoftStoreCommerceProvider>) => CommerceProvider,
): ConformanceDigitalGoods {
  const listed: MicrosoftStoreDigitalGoodsPurchase[] = [];
  const grants = new Map<string, string>();
  const requestQueue: CommerceConformanceRequestResultFixture[] = [];
  const storage = new Map<string, string>();
  let purchaseUiOpened = 0;

  const list = (fixture: CommerceConformancePurchaseFixture): MicrosoftStoreDigitalGoodsPurchase => {
    if (fixture.state === 'revoked') {
      throw new Error('Digital Goods never lists a revoked purchase; the ledger revokes.');
    }
    const purchase = { itemId: fixture.storeSku, purchaseToken: fixture.token } as const;
    const identity = purchaseIdentity(purchase);
    if (!listed.some((entry) => purchaseIdentity(entry) === identity)) {
      listed.push(purchase);
    }
    if (fixture.settlement !== undefined) {
      grants.set(identity, fixture.settlement.ledgerEntryId);
    }
    return purchase;
  };
  const ownership = async (input: MicrosoftStoreRecoveryAuthorityInput) => ({
    status: 'granted' as const,
    idempotencyKey: input.idempotencyKey ?? `durable:${input.purchaseToken}`,
  });
  const authority: MicrosoftStorePurchaseAuthority = {
    async getAvailability() {
      return 'available';
    },
    claimRecoveryOwnership: ownership,
    hasRecoveryOwnership: ownership,
    async verifyAndGrant(input) {
      const ledgerEntryId = grants.get(
        purchaseIdentity({
          itemId: input.inAppOfferToken,
          purchaseToken: input.purchaseToken,
        }),
      );
      if (ledgerEntryId === undefined) {
        return { status: 'pending' };
      }
      return { status: 'completed', transactionId: ledgerEntryId, alreadyProcessed: false };
    },
    async getEntitlements() {
      return [];
    },
  };
  const products = context.catalog.map((entry): MicrosoftStoreCommerceProduct => {
    if (entry.kind !== 'consumable') {
      throw new Error(`Digital Goods sells consumables only; ${entry.logicalId} cannot be mapped.`);
    }
    return {
      info: {
        id: entry.logicalId,
        type: 'consumable',
        title: entry.logicalId,
        description: `Fixture product ${entry.storeSku}`,
        price: { formatted: '$0.99', currencyCode: 'USD' },
      },
      inAppOfferToken: entry.storeSku,
    };
  });
  const provider = createMicrosoftStoreCommerceProvider({
    // The vector's expectations name its fixture store id; production keeps the default.
    store: context.profile.store,
    products,
    authority,
    getRecoveryScope: () => context.playerId,
    recoveryIdStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
    async getDigitalGoodsService() {
      return {
        async getDetails(itemIds) {
          return context.catalog
            .filter((entry) => itemIds.includes(entry.storeSku))
            .map((entry) => ({
              itemId: entry.storeSku,
              title: entry.logicalId,
              description: `Fixture product ${entry.storeSku}`,
              price: { currency: 'USD', value: '0.99' },
            }));
        },
        async listPurchases() {
          return [...listed];
        },
      };
    },
    createPaymentRequest(methodData) {
      const sku = methodData[0]?.data.sku;
      return {
        async show(): Promise<MicrosoftStorePaymentResponse> {
          purchaseUiOpened += 1;
          const queued = requestQueue.shift() ?? { outcome: 'launched' };
          if (queued.outcome === 'purchased') {
            return { details: { purchaseToken: list(queued.purchase).purchaseToken } };
          }
          if (queued.outcome === 'launched') {
            // The payment resolved but the Store has not listed it yet.
            return { details: { purchaseToken: sku } };
          }
          if (queued.error.code === 'USER_CANCELLED') {
            throw Object.assign(new Error('Payment Request dismissed.'), { name: 'AbortError' });
          }
          throw Object.assign(new Error(`Fixture payment failure: ${queued.error.code}.`), {
            code: queued.error.code,
            retryable: queued.error.retryable,
            ...(queued.error.storeCode === undefined ? {} : { storeCode: queued.error.storeCode }),
          });
        },
      };
    },
  });
  const actor: CommerceConformanceStoreActor = {
    get purchaseUiOpened() {
      return purchaseUiOpened;
    },
    get finishCalls() {
      // lifecycle.finish is 'server': the client has no finish surface at all.
      return [];
    },
    complete(fixture) {
      list(fixture);
    },
    update(fixture) {
      list(fixture);
    },
    error() {
      throw new Error(
        'Digital Goods has no purchase error event; a Payment Request call carries its own outcome.',
      );
    },
    queueRequest(result) {
      requestQueue.push(result);
    },
    queueFinish() {
      throw new Error('The Microsoft Store client never finishes; the backend consume finalizer does.');
    },
    finalize(request) {
      const index = listed.findIndex((entry) => entry.purchaseToken === request.transactionId);
      if (index !== -1) {
        listed.splice(index, 1);
      }
    },
  };
  return { provider: install(provider), actor };
}

function createVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const { provider, actor } = createConformanceDigitalGoods(context, (created) => created);
  return { provider, store: actor };
}

function createGatewayVectorProvider(
  context: CommerceConformanceContext,
): CommerceConformanceHarness {
  const { provider, actor } = createConformanceDigitalGoods(context, (created) => {
    const base: PlatformGateway = {
      ...createBrowserPlatformGateway({ storage: { getItem: () => null, setItem() {} } }),
      target: 'microsoft-store',
    };
    const gateway = withMicrosoftStoreCommerceProvider(base, created);
    if (gateway.commerceV2 === undefined) {
      throw new Error('The gateway must expose the installed commerce v2 provider.');
    }
    return gateway.commerceV2;
  });
  return { provider, store: actor };
}

describe('Microsoft Store commerce provider conformance', () => {
  it('classifies every store vector against the microsoft-store profile', () => {
    expect(storeVectors).toHaveLength(11);
    const skipped = Object.fromEntries(storeVectors.flatMap((vector) => {
      const reason = microsoftStoreVectorIncompatibility(vector.profile);
      return reason === undefined ? [] : [[vector.vector, reason]];
    }));
    expect(Object.keys(skipped).sort()).toEqual(Object.keys(expectedSkips).sort());
    for (const [vector, pattern] of Object.entries(expectedSkips)) {
      expect(skipped[vector], vector).toMatch(pattern);
    }
    expect(microsoftStoreVectors.map((vector) => vector.vector)).toEqual(['adapter-settled']);
  });

  it('passes every compatible vector against the fake Digital Goods path', async () => {
    const results = await runCommerceConformanceVectors(microsoftStoreVectors, {
      createProvider: createVectorProvider,
    });
    expect(results.map((result) => ({
      vector: result.vector, passed: result.passed, failures: result.failures,
    }))).toEqual(microsoftStoreVectors.map((vector) => ({
      vector: vector.vector, passed: true, failures: [],
    })));
  });

  it('passes every compatible vector through the gateway commerceV2 surface', async () => {
    const results = await runCommerceConformanceVectors(microsoftStoreVectors, {
      createProvider: createGatewayVectorProvider,
    });
    expect(results.map((result) => ({
      vector: result.vector, passed: result.passed, failures: result.failures,
    }))).toEqual(microsoftStoreVectors.map((vector) => ({
      vector: vector.vector, passed: true, failures: [],
    })));
  });

  it('fails a compatible vector whose expectation the provider cannot meet', async () => {
    const vector = microsoftStoreVectors.find((candidate) => candidate.vector === 'adapter-settled');
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

  it('cannot pass a client-token vector, which is why those are skipped', async () => {
    const vector = storeVectors.find((candidate) => candidate.vector === 'purchase-server-finish');
    if (vector === undefined) {
      throw new Error('Missing vector.');
    }
    const [result] = await runCommerceConformanceVectors([vector], {
      createProvider: createVectorProvider,
    });
    // The authority has no settlement for a token-only purchase, so the
    // attempt stays launched and the vector's journal expectation fails.
    expect(result?.passed).toBe(false);
    expect(result?.failures.length).toBeGreaterThan(0);
  });
});
