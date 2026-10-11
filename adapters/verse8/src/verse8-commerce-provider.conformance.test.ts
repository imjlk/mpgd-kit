import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCommerceConformanceCapabilities,
  isAdaptiveCommerceConformanceVector,
  runCommerceConformanceVectors,
  type CommerceConformanceContext,
  type CommerceConformanceHarness,
  type CommerceConformanceStoreActor,
  type CommerceConformanceVectorResult,
} from '@mpgd/platform/commerce-conformance';
import {
  assertCommerceConformanceVector,
  type CommerceConformancePurchaseFixture,
  type CommerceConformanceRequestResultFixture,
  type CommerceConformanceVector,
} from '@mpgd/platform/commerce-vectors';

import {
  createVerse8CommerceCapabilities,
  type Verse8RecordedPurchase,
} from './commerce-contract.js';
import {
  createVerse8CommerceProvider,
  type Verse8CommerceProviderProduct,
  type Verse8CommerceShopClient,
  type Verse8CommerceShopItem,
  type Verse8PurchasesChangeListener,
} from './commerce-provider.js';
import { createVerse8PlatformGateway } from './index.js';

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

/**
 * Why the Verse8 provider cannot serve a vector, or `undefined` when the
 * runner can run it. An adaptive vector is matched against expectations the
 * runner derives from the provider's `finish: 'none'`, server-push profile
 * under the `verse8` id, so only a step VXShop has no surface for rules it
 * out: a `store.error` event (the VXShop dialog reports no checkout error to
 * the iframe; a scripted failure is a synchronous `failed` result) and a
 * store-side `pending` purchase (the Agent8 server records granted purchases
 * only; the profile's `pending` is the server-side pending of the server-push
 * lookup). A profile-specific vector is compared against expectations written
 * for its fixture profile, so its finish owner and evidence authority must
 * match the Verse8 profile; `server-push-settlement` does, and the provider
 * runs it under the fixture store id the way the vector names it.
 */
export function verse8VectorIncompatibility(vector: CommerceConformanceVector): string | undefined {
  if (vector.wallet !== undefined) {
    return 'wallet vector: the project-owned credit wallet (B7), no store SDK';
  }
  if (isAdaptiveCommerceConformanceVector(vector)) {
    if (vector.steps.some((step) => step.actor === 'store' && step.action === 'error')) {
      return 'store.error: the VXShop dialog reports no checkout error to the iframe; a failure '
        + 'is a synchronous failed result of the purchase call';
    }
    if (vector.steps.some((step) =>
      step.actor === 'store'
      && (step.action === 'complete' || step.action === 'update')
      && step.purchase.state === 'pending')) {
      return 'store-side pending: the Agent8 server records granted purchases only; the profile '
        + 'pending flag is the server-side pending of the server-push lookup, which no fixture '
        + 'step scripts';
    }
    return undefined;
  }
  const capabilities = createCommerceConformanceCapabilities(vector.profile);
  const verse8 = createVerse8CommerceCapabilities('available');
  if (capabilities.lifecycle.finish !== verse8.lifecycle.finish) {
    return `lifecycle.finish '${capabilities.lifecycle.finish}': the Agent8 $onItemPurchased `
      + 'event settles on the server; the client finishes nothing';
  }
  if (capabilities.authority.evidence !== verse8.authority.evidence) {
    return `authority.evidence '${capabilities.authority.evidence}': Verse8 evidence is the `
      + 'Agent8 purchase id the backend looks up in the record the event wrote';
  }
  return undefined;
}

const expectedSkips: Readonly<Record<string, RegExp>> = {
  'adapter-settled': /^lifecycle\.finish 'server'/u,
  'cancelled-and-failed': /^store\.error: the VXShop dialog/u,
  'credit-lot-title-scope': /^wallet vector/u,
  'credit-membership-renewal': /^wallet vector/u,
  'membership-store-billing-target': /^wallet vector/u,
  'purchase-pending-then-purchased': /^store-side pending: the Agent8 server records/u,
};
const verse8Vectors = vectors.filter((vector) => verse8VectorIncompatibility(vector) === undefined);
/**
 * What the runner reports per vector it is handed, under the declared
 * `finish: 'none'`: `purchase-client-finish` is the canonical family member
 * (the first by name, since no member is named after `none`), the other two
 * are its duplicates, `finish-failure-retry` scripts a client finish the
 * profile has no owner for, and the rest run with expectations derived for
 * the `verse8` id. `server-push-settlement` is profile-specific and runs with
 * its fixture expectations.
 */
const expectedRunnerStatuses: readonly {
  readonly vector: string;
  readonly status: 'passed' | 'skipped';
  readonly reason?: string;
}[] = [
  { vector: 'event-before-listener', status: 'passed' },
  {
    vector: 'finish-failure-retry',
    status: 'skipped',
    reason: "queueFinish scripts a client finish; the provider declares finish: 'none'",
  },
  { vector: 'purchase-client-finish', status: 'passed' },
  {
    vector: 'purchase-host-finish',
    status: 'skipped',
    reason: "duplicate of purchase-client-finish for finish='none'",
  },
  {
    vector: 'purchase-server-finish',
    status: 'skipped',
    reason: "duplicate of purchase-client-finish for finish='none'",
  },
  { vector: 'restart-before-verify', status: 'passed' },
  { vector: 'revoked-after-grant', status: 'passed' },
  { vector: 'server-push-settlement', status: 'passed' },
];

interface ConformanceVerse8 {
  readonly products: readonly Verse8CommerceProviderProduct[];
  readonly client: Verse8CommerceShopClient;
  readonly recorded: readonly Verse8RecordedPurchase[];
  readonly actor: CommerceConformanceStoreActor;
  listPurchases(): Promise<readonly Verse8RecordedPurchase[]>;
  onPurchasesChanged(listener: Verse8PurchasesChangeListener): () => void;
}

/**
 * The fake Verse8 of a vector: VXShop lists every catalog product as
 * purchasable, `buyItem` opens the dialog (counted as the purchase UI), and
 * `complete` is the Agent8 server recording the purchase from
 * `$onItemPurchased`, signalled to the iframe the way the dialog closing
 * after a purchase is. A scripted `failed` answer makes the shop refresh fail
 * with the fixture's store code; a `cancelled` one closes the dialog without
 * a purchase. Every grant is the backend's scripted verify decision; nothing
 * here grants.
 */
function createConformanceVerse8(context: CommerceConformanceContext): ConformanceVerse8 {
  const recorded: Verse8RecordedPurchase[] = [];
  const requestQueue: CommerceConformanceRequestResultFixture[] = [];
  const listeners = new Set<Verse8PurchasesChangeListener>();
  let purchaseUiOpened = 0;
  let nextRefreshFailure: { readonly code: string } | undefined;
  const products = context.catalog.map(
    (entry): Verse8CommerceProviderProduct => ({
      id: entry.logicalId,
      type: entry.kind === 'consumable' ? 'consumable' : 'non_consumable',
      platformProductId: entry.storeSku,
    }),
  );
  const items = products.map(
    (product): Verse8CommerceShopItem => ({
      productId: product.platformProductId,
      name: product.id,
      description: `Fixture item ${product.platformProductId}`,
      price: 10,
      purchasable: true,
      purchaseLimitReached: false,
    }),
  );
  const record = (fixture: CommerceConformancePurchaseFixture): void => {
    if (fixture.state !== 'purchased') {
      throw new Error(
        `The Agent8 server records granted purchases only, not ${fixture.state} ones.`,
      );
    }
    const purchase: Verse8RecordedPurchase = {
      purchaseId: fixture.transactionId,
      productId: fixture.storeSku,
      quantity: 1,
      grantedAt: fixture.purchasedAt ?? context.clock.now(),
    };
    const index = recorded.findIndex((candidate) => candidate.purchaseId === purchase.purchaseId);
    if (index === -1) {
      recorded.push(purchase);
    } else {
      recorded[index] = purchase;
    }
    // The signal names the purchase the way a game-owned realtime message
    // would, so the iframe reports it at once; the read that follows confirms it.
    for (const listener of [...listeners]) {
      listener({ purchases: [purchase] });
    }
  };
  const client: Verse8CommerceShopClient = {
    init() {},
    getItem: (productId) => items.find((item) => item.productId === productId),
    getItems: () => [...items],
    buyItem() {
      purchaseUiOpened += 1;
      const queued = requestQueue.shift();
      if (queued?.outcome === 'purchased') {
        // The dialog completed and the Agent8 event already landed.
        record(queued.purchase);
      }
    },
    async refresh() {
      const failure = nextRefreshFailure;
      nextRefreshFailure = undefined;
      if (failure !== undefined) {
        throw failure;
      }
    },
  };
  const actor: CommerceConformanceStoreActor = {
    get purchaseUiOpened() {
      return purchaseUiOpened;
    },
    get finishCalls() {
      // lifecycle.finish is 'none': the client has no finish surface at all.
      return [];
    },
    complete: record,
    update: record,
    // A host-order store reports the purchase id as the token (RFC "Client contract").
    tokenOf: (purchase) => purchase.transactionId,
    error() {
      throw new Error('VXShop has no asynchronous checkout error; the vector is skipped.');
    },
    queueRequest(result) {
      if (result.outcome === 'failed') {
        nextRefreshFailure = { code: result.error.storeCode ?? result.error.code };
        return;
      }
      requestQueue.push(result);
    },
    queueFinish() {
      throw new Error('The Verse8 client never finishes; the vector is skipped.');
    },
  };
  return {
    products,
    client,
    recorded,
    actor,
    listPurchases: async () => [...recorded],
    onPurchasesChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The store id a vector runs under: adaptive vectors derive for `verse8`, a profile-specific one names its fixture store. */
function storeOf(context: CommerceConformanceContext): { readonly store?: string } {
  return isAdaptiveCommerceConformanceVector(context.vector)
    ? {}
    : { store: context.profile.store };
}

function createVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const verse8 = createConformanceVerse8(context);
  const provider = createVerse8CommerceProvider({
    ...storeOf(context),
    products: verse8.products,
    client: verse8.client,
    purchases: { listPurchases: verse8.listPurchases },
    canOpenShop: () => true,
    onPurchasesChanged: (listener) => verse8.onPurchasesChanged(listener),
  });
  return { provider, store: verse8.actor };
}

/** The gateway path: the provider `createVerse8PlatformGateway` installs from the `vxShop` options. */
function createGatewayVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const verse8 = createConformanceVerse8(context);
  if (storeOf(context).store !== undefined) {
    // The gateway provider is always `verse8`; the profile-specific vector
    // runs under its fixture id through the direct path only.
    return createVectorProvider(context);
  }
  const gateway = createVerse8PlatformGateway({
    vxShop: {
      purchaseEventAuthority: 'agent8-server',
      products: verse8.products,
      loadEntitlements: async () => [],
      client: verse8.client,
      canOpenShop: () => true,
      purchases: { listPurchases: verse8.listPurchases },
      onPurchasesChanged: (listener) => verse8.onPurchasesChanged(listener),
    },
  });
  if (gateway.commerceV2 === undefined) {
    throw new Error('The gateway must expose the commerce v2 provider.');
  }
  return { provider: gateway.commerceV2, store: verse8.actor };
}

function summarize(results: readonly CommerceConformanceVectorResult[]) {
  return results.map((result) => ({
    vector: result.vector,
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.failures.length === 0 ? {} : { failures: result.failures }),
  }));
}

/** The adaptive runs must have derived the finish-none, server-push shape under the verse8 id. */
function expectServerPushDerivation(results: readonly CommerceConformanceVectorResult[]): void {
  for (const result of results) {
    if (result.status !== 'passed' || result.adaptive === undefined) {
      continue;
    }
    expect(result.adaptive.store, result.vector).toBe('verse8');
    expect(result.adaptive.finish, result.vector).toBe('none');
    expect(result.adaptive.evidence, result.vector).toBe('server-push');
    expect(result.adaptive.expect.finishCalls, result.vector).toEqual([]);
    const verifyRequests = result.adaptive.expect.verifyRequests ?? [];
    expect(verifyRequests.length, result.vector).toBeGreaterThan(0);
    expect(
      verifyRequests.every((request) =>
        request.store === 'verse8' && request.token === request.transactionId),
      result.vector,
    ).toBe(true);
    // No available-purchase list: the reference store lists nothing either.
    expect(result.adaptive.expect.available, result.vector).toEqual([]);
    const journal = Object.values(result.adaptive.expect.journal ?? {});
    expect(journal.length, result.vector).toBeGreaterThan(0);
    for (const states of journal) {
      expect(states, result.vector).toContain('granted');
      expect(states, result.vector).not.toContain('finishing');
    }
  }
}

describe('Verse8 commerce provider conformance', () => {
  it('classifies every vector against the verse8 profile', () => {
    expect(vectors).toHaveLength(14);
    const skipped = Object.fromEntries(vectors.flatMap((vector) => {
      const reason = verse8VectorIncompatibility(vector);
      return reason === undefined ? [] : [[vector.vector, reason]];
    }));
    expect(Object.keys(skipped).sort()).toEqual(Object.keys(expectedSkips).sort());
    for (const [vector, pattern] of Object.entries(expectedSkips)) {
      expect(skipped[vector], vector).toMatch(pattern);
    }
    expect(verse8Vectors.map((vector) => vector.vector)).toEqual(
      expectedRunnerStatuses.map((entry) => entry.vector),
    );
  });

  it('runs every applicable vector against the fake Verse8 directly', async () => {
    const results = await runCommerceConformanceVectors(verse8Vectors, {
      createProvider: createVectorProvider,
    });
    expect(summarize(results)).toEqual(expectedRunnerStatuses);
    expectServerPushDerivation(results);
  });

  it('runs every applicable vector through the gateway path', async () => {
    const results = await runCommerceConformanceVectors(verse8Vectors, {
      createProvider: createGatewayVectorProvider,
    });
    expect(summarize(results)).toEqual(expectedRunnerStatuses);
    expectServerPushDerivation(results);
  });

  it('settles a server-push purchase only once the Agent8 event wrote the ledger', async () => {
    const vector = verse8Vectors.find((candidate) => candidate.vector === 'server-push-settlement');
    if (vector === undefined) {
      throw new Error('Missing vector.');
    }
    const [result] = await runCommerceConformanceVectors([vector], {
      createProvider: createVectorProvider,
    });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
    expect(result?.adaptive).toBeUndefined();
  });

  it('derives the verse8 purchase key for a purchase discovered without a record', async () => {
    const results = await runCommerceConformanceVectors(verse8Vectors, {
      createProvider: createVectorProvider,
    });
    const result = results.find((candidate) => candidate.vector === 'event-before-listener');
    expect(result?.adaptive?.expect.journal).toEqual({
      'store:verse8:tx-1': ['purchased', 'verifying', 'granted', 'finished'],
    });
    expect(result?.adaptive?.expect.verifyRequests).toEqual([
      {
        idempotencyKey: 'store:verse8:tx-1',
        store: 'verse8',
        transactionId: 'tx-1',
        token: 'tx-1',
      },
    ]);
  });

  it('fails an applicable vector whose expectation the provider cannot meet', async () => {
    const vector = verse8Vectors.find((candidate) => candidate.vector === 'restart-before-verify');
    if (vector === undefined) {
      throw new Error('Missing vector.');
    }
    const [result] = await runCommerceConformanceVectors(
      [{ ...vector, expect: { ...vector.expect, purchaseUiOpened: 99 } }],
      { createProvider: createVectorProvider },
    );
    expect(result?.status).toBe('failed');
    expect(result?.failures).toEqual([{ path: 'purchaseUiOpened', expected: 99, actual: 1 }]);
  });

  it('fails a profile-specific vector whose fixture profile Verse8 does not match', async () => {
    const vector = vectors.find((candidate) => candidate.vector === 'adapter-settled');
    if (vector === undefined) {
      throw new Error('Missing vector.');
    }
    const [result] = await runCommerceConformanceVectors([vector], {
      createProvider: createVectorProvider,
    });
    expect(result?.status).toBe('failed');
    expect(result?.adaptive).toBeUndefined();
    expect(result?.failures.length).toBeGreaterThan(0);
  });
});
