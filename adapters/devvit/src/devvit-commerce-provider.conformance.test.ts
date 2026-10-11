import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createCommerceV2UnavailableBridgeError,
  type BridgeRequest,
  type BridgeResponse,
} from '@mpgd/bridge';
import type { ProductInfo } from '@mpgd/platform';
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

import { createDevvitCommerceCapabilities, type DevvitPaidOrder } from './commerce-contract.js';
import {
  createDevvitCommerceProvider,
  type DevvitOrdersChangeListener,
  type DevvitOrderSource,
} from './commerce-provider.js';
import { createDevvitPlatformGateway, type DevvitBridge } from './index.js';
import type {
  DevvitCheckoutResult,
  DevvitCommerceProduct,
  DevvitPaymentsClient,
} from './payments.js';
import {
  createDevvitCommerceV2BridgeHandler,
  type DevvitPaymentsOrderLike,
  type DevvitServerPaymentsLike,
} from './server/commerce-bridge.js';

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
 * Why the Devvit provider cannot serve a vector, or `undefined` when the
 * runner can run it. An adaptive vector is matched against expectations the
 * runner derives from the provider's `finish: 'none'`, server-push profile
 * under the `devvit` id, so only a step Reddit has no surface for rules it
 * out: a `store.error` event (every checkout outcome arrives as the result of
 * the purchase call; there is no later error event) and a store-side
 * `pending` purchase (Reddit lists paid orders only; the profile's `pending`
 * is the server-side pending of the server-push lookup). A profile-specific
 * vector is compared against expectations written for its fixture profile,
 * so its finish owner and evidence authority must match the Devvit profile;
 * `server-push-settlement` does, and the provider runs it under the fixture
 * store id the way the vector names it.
 */
export function devvitVectorIncompatibility(vector: CommerceConformanceVector): string | undefined {
  if (vector.wallet !== undefined) {
    return 'wallet vector: the project-owned credit wallet (B7), no store SDK';
  }
  if (isAdaptiveCommerceConformanceVector(vector)) {
    if (vector.steps.some((step) => step.actor === 'store' && step.action === 'error')) {
      return 'store.error: a Devvit checkout delivers its outcome as the result of the purchase '
        + 'call (OrderResultEvent); there is no later error event';
    }
    if (vector.steps.some((step) =>
      step.actor === 'store'
      && (step.action === 'complete' || step.action === 'update')
      && step.purchase.state === 'pending')) {
      return 'store-side pending: Reddit lists paid orders only; the profile pending flag is the '
        + 'server-side pending of the server-push lookup, which no fixture step scripts';
    }
    return undefined;
  }
  const capabilities = createCommerceConformanceCapabilities(vector.profile);
  const devvit = createDevvitCommerceCapabilities('available');
  if (capabilities.lifecycle.finish !== devvit.lifecycle.finish) {
    return `lifecycle.finish '${capabilities.lifecycle.finish}': the Devvit fulfillment handler `
      + 'settles on the server; the client finishes nothing';
  }
  if (capabilities.authority.evidence !== devvit.authority.evidence) {
    return `authority.evidence '${capabilities.authority.evidence}': Devvit evidence is the order `
      + 'id the backend looks up in the ledger the fulfillment handler wrote';
  }
  return undefined;
}

const expectedSkips: Readonly<Record<string, RegExp>> = {
  'adapter-settled': /^lifecycle\.finish 'server'/u,
  'cancelled-and-failed': /^store\.error: a Devvit checkout/u,
  'credit-lot-title-scope': /^wallet vector/u,
  'credit-membership-renewal': /^wallet vector/u,
  'membership-store-billing-target': /^wallet vector/u,
  'purchase-pending-then-purchased': /^store-side pending: Reddit lists paid orders only/u,
};
const devvitVectors = vectors.filter((vector) => devvitVectorIncompatibility(vector) === undefined);
/**
 * What the runner reports per vector it is handed, under the declared
 * `finish: 'none'`: `purchase-client-finish` is the canonical family member
 * (the first by name, since no member is named after `none`), the other two
 * are its duplicates, `finish-failure-retry` scripts a client finish the
 * profile has no owner for, and the rest run with expectations derived for
 * the `devvit` id. `server-push-settlement` is profile-specific and runs with
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

interface ConformanceReddit {
  readonly products: readonly DevvitCommerceProduct[];
  readonly client: Pick<DevvitPaymentsClient, 'purchase'>;
  readonly orders: DevvitOrderSource;
  readonly payments: DevvitServerPaymentsLike;
  readonly actor: CommerceConformanceStoreActor;
  onOrdersChanged(listener: DevvitOrdersChangeListener): () => void;
}

/**
 * The fake Reddit of a vector: `complete` lists the paid order the way
 * `payments.getOrders` does (`PAID`, one product) and signals the webview
 * that the list changed; an order stays listed until the host's fulfillment
 * push (`backend.push`, the fulfillment handler acknowledging delivery) lands
 * in the ledger, after which Reddit marks it `DELIVERED` and stops listing
 * it. An unscripted checkout answers without an order id (`launched`), a
 * scripted `purchased` answer carries the created order id, and a
 * `cancelled` or `failed` answer keeps the fixture's store code. Every grant
 * is the backend's scripted verify decision; nothing here grants.
 */
function createConformanceReddit(context: CommerceConformanceContext): ConformanceReddit {
  const paidOrders: DevvitPaidOrder[] = [];
  const requestQueue: CommerceConformanceRequestResultFixture[] = [];
  const listeners = new Set<DevvitOrdersChangeListener>();
  let purchaseUiOpened = 0;
  const delivered = (orderId: string): boolean =>
    context.backend.ledger.some(
      (entry) => entry.type === 'grant' && entry.pushed === true && entry.transactionId === orderId,
    );
  const listed = (): readonly DevvitPaidOrder[] =>
    paidOrders.filter((order) => !delivered(order.orderId));
  const list = (fixture: CommerceConformancePurchaseFixture): DevvitPaidOrder => {
    if (fixture.state !== 'purchased') {
      throw new Error(`Reddit lists paid orders only, not ${fixture.state} ones.`);
    }
    const order: DevvitPaidOrder = {
      orderId: fixture.transactionId,
      sku: fixture.storeSku,
      paidAt: fixture.purchasedAt ?? context.clock.now(),
      environment: 'sandbox',
    };
    const index = paidOrders.findIndex((candidate) => candidate.orderId === order.orderId);
    if (index === -1) {
      paidOrders.push(order);
    } else {
      paidOrders[index] = order;
    }
    return order;
  };
  // The signal names the order the way a realtime message would, so the
  // webview reports it at once; the list read that follows confirms it.
  const report = (fixture: CommerceConformancePurchaseFixture): void => {
    const order = list(fixture);
    for (const listener of [...listeners]) {
      listener({ orders: [order] });
    }
  };
  const products = context.catalog.map((entry): DevvitCommerceProduct => ({
    info: {
      id: entry.logicalId,
      type: entry.kind === 'consumable' ? 'consumable' : 'non_consumable',
      title: entry.logicalId,
      description: `Fixture product ${entry.storeSku}`,
      price: { formatted: '5 Gold', currencyCode: 'GOLD' },
    } satisfies ProductInfo,
    sku: entry.storeSku,
  }));
  const client: Pick<DevvitPaymentsClient, 'purchase'> = {
    async purchase(): Promise<DevvitCheckoutResult> {
      purchaseUiOpened += 1;
      const queued = requestQueue.shift() ?? { outcome: 'launched' };
      if (queued.outcome === 'launched') {
        // The checkout resolved without an order id the webview can use.
        return { status: 'pending' };
      }
      if (queued.outcome === 'purchased') {
        return { status: 'completed', orderId: list(queued.purchase).orderId };
      }
      return {
        status: queued.outcome,
        error: {
          code: queued.error.code,
          retryable: queued.error.retryable,
          ...(queued.error.storeCode === undefined ? {} : { storeCode: queued.error.storeCode }),
        },
      };
    },
  };
  const payments: DevvitServerPaymentsLike = {
    async getOrders() {
      return {
        orders: listed().map(
          (order): DevvitPaymentsOrderLike => ({
            id: order.orderId,
            status: 3,
            createdAt: order.paidAt,
            updatedAt: order.paidAt,
            products: [{ sku: order.sku }],
            environment: 1,
          }),
        ),
        pageInfo: { hasNextPage: false, endCursor: '' },
      };
    },
    async getProducts() {
      return {
        products: products.map((product) => ({
          sku: product.sku,
          name: product.info.title,
          description: product.info.description,
          price: { amount: 5, currency: 200 },
          accountingType: product.info.type === 'consumable' ? 3 : 2,
        })),
      };
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
    complete: report,
    update: report,
    // A host-order store reports the order id as the token (RFC "Client contract").
    tokenOf: (purchase) => purchase.transactionId,
    error() {
      throw new Error('Reddit has no asynchronous checkout error; the vector is skipped.');
    },
    queueRequest(result) {
      requestQueue.push(result);
    },
    queueFinish() {
      throw new Error('The Devvit client never finishes; the vector is skipped.');
    },
  };
  return {
    products,
    client,
    orders: { listPaidOrders: async () => listed() },
    payments,
    actor,
    onOrdersChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The store id a vector runs under: adaptive vectors derive for `devvit`, a profile-specific one names its fixture store. */
function storeOf(context: CommerceConformanceContext): { readonly store?: string } {
  return isAdaptiveCommerceConformanceVector(context.vector)
    ? {}
    : { store: context.profile.store };
}

function createVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const reddit = createConformanceReddit(context);
  const provider = createDevvitCommerceProvider({
    ...storeOf(context),
    products: reddit.products,
    client: reddit.client,
    orders: reddit.orders,
    onOrdersChanged: (listener) => reddit.onOrdersChanged(listener),
  });
  return { provider, store: reddit.actor };
}

/**
 * The gateway path: the webview provider over `createDevvitPlatformGateway`
 * whose bridge routes `commerce.v2.*` to the server handler over the fake
 * payments plugin, exactly as the Devvit server bridge does with its
 * `commerce` dependency.
 */
function createBridgedVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const reddit = createConformanceReddit(context);
  const store = storeOf(context);
  const handler = createDevvitCommerceV2BridgeHandler({
    ...store,
    payments: reddit.payments,
    products: reddit.products.map((product) => ({ productId: product.info.id, sku: product.sku })),
    warn: () => {},
  });
  const bridge: DevvitBridge = {
    async request(input: BridgeRequest): Promise<BridgeResponse> {
      if (input.method.startsWith('commerce.v2.')) {
        return handler.request(input);
      }
      if (input.method === 'runtime.getCapabilities') {
        return { id: input.id, ok: true, data: { nativeIap: false, cloudSave: true } };
      }
      return createCommerceV2UnavailableBridgeError(input, 'conformance bridge');
    },
  };
  const gateway = createDevvitPlatformGateway({
    appVersion: '1.0.0',
    buildId: `conformance:${context.vector.vector}`,
    bridge,
    commerce: {
      ...store,
      products: reddit.products,
      client: reddit.client,
      onOrdersChanged: (listener) => reddit.onOrdersChanged(listener),
    },
  });
  if (gateway.commerceV2 === undefined) {
    throw new Error('The gateway must expose the commerce v2 provider.');
  }
  return { provider: gateway.commerceV2, store: reddit.actor };
}

function summarize(results: readonly CommerceConformanceVectorResult[]) {
  return results.map((result) => ({
    vector: result.vector,
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.failures.length === 0 ? {} : { failures: result.failures }),
  }));
}

/** The adaptive runs must have derived the finish-none, server-push shape under the devvit id. */
function expectServerPushDerivation(results: readonly CommerceConformanceVectorResult[]): void {
  for (const result of results) {
    if (result.status !== 'passed' || result.adaptive === undefined) {
      continue;
    }
    expect(result.adaptive.store, result.vector).toBe('devvit');
    expect(result.adaptive.finish, result.vector).toBe('none');
    expect(result.adaptive.evidence, result.vector).toBe('server-push');
    expect(result.adaptive.expect.finishCalls, result.vector).toEqual([]);
    const verifyRequests = result.adaptive.expect.verifyRequests ?? [];
    expect(verifyRequests.length, result.vector).toBeGreaterThan(0);
    expect(
      verifyRequests.every((request) =>
        request.store === 'devvit' && request.token === request.transactionId),
      result.vector,
    ).toBe(true);
    // Nothing finishes a Devvit order on the client: a paid order stays
    // listed until the fulfillment handler acknowledges its delivery.
    expect(result.adaptive.expect.available?.length, result.vector).toBeGreaterThan(0);
    const journal = Object.values(result.adaptive.expect.journal ?? {});
    expect(journal.length, result.vector).toBeGreaterThan(0);
    for (const states of journal) {
      expect(states, result.vector).toContain('granted');
      expect(states, result.vector).not.toContain('finishing');
    }
  }
}

describe('Devvit commerce provider conformance', () => {
  it('classifies every vector against the devvit profile', () => {
    expect(vectors).toHaveLength(14);
    const skipped = Object.fromEntries(vectors.flatMap((vector) => {
      const reason = devvitVectorIncompatibility(vector);
      return reason === undefined ? [] : [[vector.vector, reason]];
    }));
    expect(Object.keys(skipped).sort()).toEqual(Object.keys(expectedSkips).sort());
    for (const [vector, pattern] of Object.entries(expectedSkips)) {
      expect(skipped[vector], vector).toMatch(pattern);
    }
    expect(devvitVectors.map((vector) => vector.vector)).toEqual(
      expectedRunnerStatuses.map((entry) => entry.vector),
    );
  });

  it('runs every applicable vector against the fake Reddit directly', async () => {
    const results = await runCommerceConformanceVectors(devvitVectors, {
      createProvider: createVectorProvider,
    });
    expect(summarize(results)).toEqual(expectedRunnerStatuses);
    expectServerPushDerivation(results);
  });

  it('runs every applicable vector through the server bridge handler and gateway path', async () => {
    const results = await runCommerceConformanceVectors(devvitVectors, {
      createProvider: createBridgedVectorProvider,
    });
    expect(summarize(results)).toEqual(expectedRunnerStatuses);
    expectServerPushDerivation(results);
  });

  it('settles a server-push purchase only once the fulfillment push wrote the ledger', async () => {
    const vector = devvitVectors.find((candidate) => candidate.vector === 'server-push-settlement');
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

  it('derives the devvit purchase key for a purchase discovered without a record', async () => {
    const results = await runCommerceConformanceVectors(devvitVectors, {
      createProvider: createVectorProvider,
    });
    const result = results.find((candidate) => candidate.vector === 'event-before-listener');
    expect(Object.keys(result?.adaptive?.expect.journal ?? {})).toEqual(['store:devvit:tx-1']);
    expect(result?.adaptive?.expect.journal).toEqual({
      'store:devvit:tx-1': ['purchased', 'verifying', 'granted', 'finished'],
    });
    expect(result?.adaptive?.expect.verifyRequests).toEqual([
      {
        idempotencyKey: 'store:devvit:tx-1',
        store: 'devvit',
        transactionId: 'tx-1',
        token: 'tx-1',
      },
    ]);
  });

  it('fails an applicable vector whose expectation the provider cannot meet', async () => {
    const vector = devvitVectors.find((candidate) => candidate.vector === 'restart-before-verify');
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

  it('fails a profile-specific vector whose fixture profile Reddit does not match', async () => {
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
