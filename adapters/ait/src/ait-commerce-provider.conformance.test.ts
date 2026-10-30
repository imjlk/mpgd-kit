import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CommerceProvider, FinishTransactionInput } from '@mpgd/platform/commerce';
import {
  createCommerceConformanceCapabilities,
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
  createFakeAitHostDependencies,
  createFakeAitIapHost,
  type FakeAitIapHost,
} from '../test/ait-iap-fixture.js';
import { createAitCommerceCapabilities, createAitCommerceProvider } from './commerce-provider.js';
import { createAitHostBridge, type AitIapProductConfig } from './host.js';
import { createAitPlatformGateway } from './index.js';

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
 * Why the Apps in Toss provider cannot serve a vector, or `undefined` when
 * the runner can run it. An adaptive vector is matched against expectations
 * the runner derives from the provider's host-finish profile under the
 * `apps-in-toss` id, so only a step the host has no surface for rules it out:
 * a `store.error` event (every checkout outcome arrives through the terminal
 * callback of the purchase call, and a cancellation carries no store code), and
 * a store-side `pending` purchase (the provider lists paid orders only; an
 * order observed in a checkout is `pending` until the host lists it, which
 * no fixture step can script). A profile-specific vector is compared against
 * expectations written for its fixture profile, so its finish owner and
 * evidence authority must match the host profile.
 */
export function aitVectorIncompatibility(vector: CommerceConformanceVector): string | undefined {
  if (vector.wallet !== undefined) {
    return 'wallet vector: the project-owned credit wallet (B7), no store SDK';
  }
  if (isAdaptiveCommerceConformanceVector(vector)) {
    if (vector.steps.some((step) => step.actor === 'store' && step.action === 'error')) {
      return 'store.error: an Apps in Toss checkout delivers its outcome through the terminal '
        + 'callback of the purchase call; there is no later error event, and a cancellation '
        + 'carries no store code';
    }
    if (vector.steps.some((step) =>
      step.actor === 'store'
      && (step.action === 'complete' || step.action === 'update')
      && step.purchase.state === 'pending')) {
      return 'store-side pending: Apps in Toss lists paid orders only; an order is pending '
        + 'while a checkout of this session observed it and the host does not list it yet, '
        + 'which no fixture step scripts';
    }
    return undefined;
  }
  const capabilities = createCommerceConformanceCapabilities(vector.profile);
  const ait = createAitCommerceCapabilities('available');
  if (capabilities.lifecycle.finish !== ait.lifecycle.finish) {
    return `lifecycle.finish '${capabilities.lifecycle.finish}': the Apps in Toss host finishes `
      + '(completeProductGrant after the ledger grant)';
  }
  if (capabilities.authority.evidence !== ait.authority.evidence) {
    return `authority.evidence '${capabilities.authority.evidence}': Apps in Toss evidence is the `
      + 'host callback order id verified by the backend';
  }
  return undefined;
}

const expectedSkips: Readonly<Record<string, RegExp>> = {
  'adapter-settled': /^lifecycle\.finish 'server'/u,
  'cancelled-and-failed': /^store\.error: an Apps in Toss checkout/u,
  'credit-lot-title-scope': /^wallet vector/u,
  'credit-membership-renewal': /^wallet vector/u,
  'membership-store-billing-target': /^wallet vector/u,
  'purchase-pending-then-purchased': /^store-side pending: Apps in Toss lists paid orders only/u,
  'server-push-settlement': /^lifecycle\.finish 'none'/u,
};
const aitVectors = vectors.filter((vector) => aitVectorIncompatibility(vector) === undefined);
/**
 * What the runner reports per vector it is handed, under the declared
 * `finish: 'host'`: the two other members of the `purchase-<owner>-finish`
 * family are duplicates of `purchase-host-finish`, and the rest run with
 * host-finish expectations derived for the `apps-in-toss` id.
 */
const expectedRunnerStatuses: readonly {
  readonly vector: string;
  readonly status: 'passed' | 'skipped';
  readonly reason?: string;
}[] = [
  { vector: 'event-before-listener', status: 'passed' },
  { vector: 'finish-failure-retry', status: 'passed' },
  {
    vector: 'purchase-client-finish',
    status: 'skipped',
    reason: "duplicate of purchase-host-finish for finish='host'",
  },
  { vector: 'purchase-host-finish', status: 'passed' },
  {
    vector: 'purchase-server-finish',
    status: 'skipped',
    reason: "duplicate of purchase-host-finish for finish='host'",
  },
  { vector: 'restart-before-verify', status: 'passed' },
  { vector: 'revoked-after-grant', status: 'passed' },
];

interface ConformanceHost {
  readonly host: FakeAitIapHost;
  readonly products: readonly AitIapProductConfig[];
  readonly actor: CommerceConformanceStoreActor;
  /** Wraps a provider so the host finish calls it makes are observed. */
  observe(provider: CommerceProvider): CommerceProvider;
}

/**
 * Translates the vector's `store` steps into the fake Apps in Toss host:
 * `complete` lists the paid order the way `getPendingOrders()` does and
 * signals the change (the app resuming from the checkout page), an
 * unscripted checkout answers with an outcome the host cannot settle yet
 * (`launched`), `queueFinish` scripts `completeProductGrant()`, and the actor
 * observes the checkouts and the host finish calls. The in-callback
 * `verifyIapProductGrant` hook never grants here: every grant is the
 * backend's verify decision, as the vectors script it.
 */
function createConformanceHost(context: CommerceConformanceContext): ConformanceHost {
  const host = createFakeAitIapHost({
    products: context.catalog.map((entry) => ({
      sku: entry.storeSku,
      type: entry.kind === 'consumable' ? 'CONSUMABLE' : 'NON_CONSUMABLE',
      displayName: entry.logicalId,
    })),
    defaultCheckout: { kind: 'deferred' },
  });
  const products = context.catalog.map((entry) => ({
    productId: entry.logicalId,
    sku: entry.storeSku,
  }));
  const finishCalls: CommerceConformanceFinishCall[] = [];
  const report = (fixture: CommerceConformancePurchaseFixture): void => {
    if (fixture.state !== 'purchased') {
      throw new Error(`The Apps in Toss host lists paid orders only, not ${fixture.state} ones.`);
    }
    host.addPendingOrder({
      orderId: fixture.transactionId,
      sku: fixture.storeSku,
      paymentCompletedDate: fixture.purchasedAt ?? context.clock.now(),
    });
  };
  const actor: CommerceConformanceStoreActor = {
    get purchaseUiOpened() {
      return host.checkoutCalls.length;
    },
    get finishCalls() {
      return [...finishCalls];
    },
    complete: report,
    update: report,
    // A host-order store reports the order id as the token (RFC "Client contract").
    tokenOf: (purchase) => purchase.transactionId,
    error() {
      throw new Error('The Apps in Toss host has no asynchronous purchase error; the vector is skipped.');
    },
    queueRequest(result) {
      if (result.outcome === 'launched') {
        host.queueCheckout({ kind: 'deferred' });
      } else if (result.outcome === 'purchased') {
        host.queueCheckout({ kind: 'grant', orderId: result.purchase.transactionId });
      } else if (result.error.code === 'USER_CANCELLED') {
        host.queueCheckout({ kind: 'cancel' });
      } else {
        host.queueCheckout({
          kind: 'error',
          error: { code: result.error.storeCode ?? result.error.code, message: 'Fixture failure.' },
        });
      }
    },
    queueFinish(result) {
      host.queueComplete(
        'error' in result
          ? { throws: { code: result.error, message: 'Fixture finish failure.' } }
          : { returns: result.finished },
      );
    },
  };
  return {
    host,
    products,
    actor,
    observe(provider) {
      const finish = provider.finishTransaction;
      if (finish === undefined) {
        throw new Error('The Apps in Toss provider must finish transactions.');
      }
      return {
        ...provider,
        async finishTransaction(input: FinishTransactionInput) {
          const before = host.completeCalls.length;
          const result = await finish.call(provider, input);
          const native = host.completeCalls[host.completeCalls.length - 1];
          const call = {
            by: 'host' as const,
            transactionId: input.transactionId,
            ...(input.ledgerEntryId === undefined ? {} : { ledgerEntryId: input.ledgerEntryId }),
            isConsumable: input.isConsumable,
          };
          if (host.completeCalls.length > before && native !== undefined) {
            finishCalls.push({
              ...call,
              result: native.result === 'true'
                ? 'finished'
                : native.result === 'false'
                  ? 'unfinished'
                  : native.result.slice('threw:'.length) as CommerceConformanceFinishCall['result'],
            });
          } else {
            // The host finished the order itself; the provider settled it without a native call.
            finishCalls.push({ ...call, result: result.finished ? 'finished' : 'unfinished' });
          }
          return result;
        },
      };
    },
  };
}

/**
 * The host's server hook answers from the fake backend's ledger: it never
 * grants on its own (the backend's scripted verify decision is the only
 * grant), and it confirms an order the backend already granted, which is
 * what the host finish checks before acknowledging.
 */
function verifierOf(context: CommerceConformanceContext) {
  return async ({ orderId }: { readonly orderId: string }): Promise<boolean> =>
    context.backend.ledger.some(
      (entry) => entry.type === 'grant' && entry.transactionId === orderId,
    );
}

function createVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const { host, products, actor, observe } = createConformanceHost(context);
  const provider = createAitCommerceProvider({
    dependencies: host.dependencies,
    iapProducts: products,
    prepareIap: async () => true,
    verifyIapProductGrant: verifierOf(context),
    onPendingOrdersChanged: (listener) => host.onPendingOrdersChanged(listener),
  });
  return { provider: observe(provider), store: actor };
}

function createBridgedVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const { host, products, actor, observe } = createConformanceHost(context);
  const bridge = createAitHostBridge({
    iapProducts: products,
    prepareIap: async () => true,
    verifyIapProductGrant: verifierOf(context),
    onPendingOrdersChanged: (listener) => host.onPendingOrdersChanged(listener),
    dependencies: createFakeAitHostDependencies(host),
  });
  const gateway = createAitPlatformGateway({
    appVersion: '1.0.0',
    buildId: `conformance:${context.vector.vector}`,
    bridge,
  });
  if (gateway.commerce === undefined) {
    throw new Error('The gateway must expose the host bridge commerce v2 provider.');
  }
  return { provider: observe(gateway.commerce), store: actor };
}

function summarize(results: readonly CommerceConformanceVectorResult[]) {
  return results.map((result) => ({
    vector: result.vector,
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.failures.length === 0 ? {} : { failures: result.failures }),
  }));
}

/** The adaptive runs must have derived the host-finish shape under the apps-in-toss id. */
function expectHostFinishDerivation(results: readonly CommerceConformanceVectorResult[]): void {
  for (const result of results) {
    if (result.status !== 'passed') {
      continue;
    }
    expect(result.adaptive?.store, result.vector).toBe('apps-in-toss');
    expect(result.adaptive?.finish, result.vector).toBe('host');
    expect(result.adaptive?.evidence, result.vector).toBe('host-callback');
    const finishCalls = result.adaptive?.expect.finishCalls ?? [];
    expect(finishCalls.length, result.vector).toBeGreaterThan(0);
    expect(
      finishCalls.every((call) => call.by === 'host' && (call.ledgerEntryId ?? '').length > 0),
      result.vector,
    ).toBe(true);
    expect(
      (result.adaptive?.expect.verifyRequests ?? []).every((request) => request.store === 'apps-in-toss'),
      result.vector,
    ).toBe(true);
    expect(result.adaptive?.expect.available, result.vector).toEqual([]);
    const journal = Object.values(result.adaptive?.expect.journal ?? {});
    expect(journal.length, result.vector).toBeGreaterThan(0);
    for (const states of journal) {
      expect(states, result.vector).toContain('finished');
    }
  }
}

describe('Apps in Toss commerce provider conformance', () => {
  it('classifies every vector against the apps-in-toss profile', () => {
    expect(vectors).toHaveLength(14);
    const skipped = Object.fromEntries(vectors.flatMap((vector) => {
      const reason = aitVectorIncompatibility(vector);
      return reason === undefined ? [] : [[vector.vector, reason]];
    }));
    expect(Object.keys(skipped).sort()).toEqual(Object.keys(expectedSkips).sort());
    for (const [vector, pattern] of Object.entries(expectedSkips)) {
      expect(skipped[vector], vector).toMatch(pattern);
    }
    expect(aitVectors.map((vector) => vector.vector)).toEqual(
      expectedRunnerStatuses.map((entry) => entry.vector),
    );
    expect(aitVectors.every(isAdaptiveCommerceConformanceVector)).toBe(true);
  });

  it('runs every applicable vector against the fake Apps in Toss host', async () => {
    const results = await runCommerceConformanceVectors(aitVectors, {
      createProvider: createVectorProvider,
    });
    expect(summarize(results)).toEqual(expectedRunnerStatuses);
    expectHostFinishDerivation(results);
  });

  it('runs every applicable vector through the host bridge and gateway path', async () => {
    const results = await runCommerceConformanceVectors(aitVectors, {
      createProvider: createBridgedVectorProvider,
    });
    expect(summarize(results)).toEqual(expectedRunnerStatuses);
    expectHostFinishDerivation(results);
  });

  it('derives the apps-in-toss purchase key for a purchase discovered without a record', async () => {
    const results = await runCommerceConformanceVectors(aitVectors, {
      createProvider: createVectorProvider,
    });
    const result = results.find((candidate) => candidate.vector === 'event-before-listener');
    expect(Object.keys(result?.adaptive?.expect.journal ?? {})).toEqual(['apps-in-toss:purchase:tx-1']);
    expect(result?.adaptive?.expect.verifyRequests).toEqual([
      {
        idempotencyKey: 'apps-in-toss:purchase:tx-1',
        store: 'apps-in-toss',
        transactionId: 'tx-1',
        token: 'tx-1',
      },
    ]);
    const retry = results.find((candidate) => candidate.vector === 'finish-failure-retry');
    expect(retry?.adaptive?.expect.finishCalls?.map((call) => call.result)).toEqual([
      'NETWORK',
      'finished',
    ]);
  });

  it('runs a family member alone with host-finish expectations', async () => {
    const vector = aitVectors.find((candidate) => candidate.vector === 'purchase-client-finish');
    if (vector === undefined) {
      throw new Error('Missing vector.');
    }
    const [result] = await runCommerceConformanceVectors([vector], {
      createProvider: createVectorProvider,
    });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
    expect(result?.adaptive?.expect.finishCalls?.map((call) => call.by)).toEqual(['host']);
    expect(result?.adaptive?.expect.verifyRequests?.length).toBe(1);
  });

  it('fails an applicable vector whose expectation the provider cannot meet', async () => {
    const vector = aitVectors.find((candidate) => candidate.vector === 'purchase-host-finish');
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

  it('fails a profile-specific vector whose fixture profile the host does not match', async () => {
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
