/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import type { CommerceProvider, StorePurchaseAccountBinding } from '@mpgd/platform/commerce';
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
  type CommerceConformanceVector,
} from '@mpgd/platform/commerce-vectors';

import {
  createFakePlayBillingPlugin,
  fakePlayProduct,
  type FakePlayBillingPlugin,
} from '../test/play-billing-plugin-fixture.js';
import {
  createCapacitorPlayBillingCommerceProvider,
  createCapacitorPlayBillingServiceProvider,
  type PlayBillingCommerceProductMapping,
} from './commerce-provider.js';
import type { PlayPurchase } from './definitions.js';
import { playBillingStoreSdkCapabilities } from './store-sdk.js';

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
// Wallet vectors exercise the project-owned credit wallet (B7); a store plugin
// has no wallet actor, so they stay on the reference harness.
const storeVectors = vectors.filter((vector) => vector.wallet === undefined);

/**
 * Why the real Play provider cannot serve a vector, or `undefined` when the
 * runner can run it. An adaptive vector (`profile.adaptive`) is matched
 * against expectations the runner derives from the Play capabilities, so only
 * a step the Play plugin has no surface for rules it out here: a `store.error`
 * event, since a Play purchase call carries its own outcome and the plugin
 * emits no purchase error event. A profile-specific vector is compared
 * against expectations written for its fixture profile, so its finish owner,
 * evidence authority, product kinds, and available-purchases support must
 * match Play's.
 */
export function playBillingVectorIncompatibility(
  vector: CommerceConformanceVector,
): string | undefined {
  if (isAdaptiveCommerceConformanceVector(vector)) {
    return vector.steps.some((step) => step.actor === 'store' && step.action === 'error')
      ? 'store.error: the Play plugin emits no purchase error event; a purchase call carries '
        + 'its own outcome'
      : undefined;
  }
  const capabilities = createCommerceConformanceCapabilities(vector.profile);
  const play = playBillingStoreSdkCapabilities;
  if (capabilities.lifecycle.finish !== play.finish) {
    return `lifecycle.finish '${capabilities.lifecycle.finish}': Play finishes on the server (the `
      + 'backend acknowledges or consumes after the grant); the client never calls finishTransaction';
  }
  if (capabilities.authority.evidence !== 'client-token') {
    return `authority.evidence '${capabilities.authority.evidence}': Play evidence is the client `
      + 'purchase token verified by the backend';
  }
  if (capabilities.purchase.subscription && !play.purchase.subscription) {
    return 'purchase.subscription: Play sells no subscriptions in this release';
  }
  if (!capabilities.lifecycle.availablePurchases) {
    return 'lifecycle.availablePurchases false: Play always lists unfinished purchases';
  }
  return undefined;
}

/** Vectors this file never hands to the runner, with the Play-specific reason. */
const expectedSkips: Readonly<Record<string, RegExp>> = {
  'adapter-settled': /^authority\.evidence 'adapter-settled'/u,
  'cancelled-and-failed': /^store\.error: the Play plugin emits no purchase error event/u,
  'server-push-settlement': /^lifecycle\.finish 'none'/u,
};
const playVectors = storeVectors.filter(
  (vector) => playBillingVectorIncompatibility(vector) === undefined,
);
/**
 * What the runner reports per vector it is handed, under Play's declared
 * `finish: 'server'`: the runner skips the client-finish retry script and the
 * two redundant members of the `purchase-<owner>-finish` family, and derives
 * server-finish expectations for the rest.
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
    reason: "queueFinish scripts a client finish; the provider declares finish: 'server'",
  },
  {
    vector: 'purchase-client-finish',
    status: 'skipped',
    reason: "duplicate of purchase-server-finish for finish='server'",
  },
  {
    vector: 'purchase-host-finish',
    status: 'skipped',
    reason: "duplicate of purchase-server-finish for finish='server'",
  },
  { vector: 'purchase-pending-then-purchased', status: 'passed' },
  { vector: 'purchase-server-finish', status: 'passed' },
  { vector: 'restart-before-verify', status: 'passed' },
  { vector: 'revoked-after-grant', status: 'passed' },
];

interface ConformancePlayPlugin {
  readonly plugin: FakePlayBillingPlugin;
  readonly actor: CommerceConformanceStoreActor;
  readonly accountBinding: StorePurchaseAccountBinding;
}

/**
 * Translates the vector's `store` steps into the fake Play plugin the way the
 * Java plugin behaves: a reported purchase is upserted into `getPurchases`
 * and emitted as `purchaseUpdated` (order id = transaction id, token =
 * purchase token, never acknowledged), an unscripted purchase call rejects
 * with `PLAY_BILLING_TIMEOUT` (the store UI is open and the result arrives
 * later as `purchaseUpdated`, which the provider answers as `launched`), a
 * scripted cancel or failure is the plugin rejection, the backend finalizer
 * consumes or acknowledges, and the client never finishes.
 */
function createConformancePlayPlugin(context: CommerceConformanceContext): ConformancePlayPlugin {
  const accountBinding: StorePurchaseAccountBinding = {
    kind: 'obfuscated-account-id',
    value: context.playerId,
  };
  const plugin = createFakePlayBillingPlugin({
    products: context.catalog.map((entry) => fakePlayProduct({ productId: entry.storeSku })),
    defaultPurchase: () => ({
      throws: {
        code: 'PLAY_BILLING_TIMEOUT',
        message: 'Purchase confirmation timed out; requery owned purchases.',
      },
    }),
  });
  const toPlayPurchase = (fixture: CommerceConformancePurchaseFixture): PlayPurchase => {
    if (fixture.state === 'revoked') {
      throw new Error('The Play plugin never reports a revoked purchase; the ledger revokes.');
    }
    const purchaseTime = fixture.purchasedAt === undefined
      ? Date.parse(context.clock.now())
      : Date.parse(fixture.purchasedAt);
    return {
      products: [fixture.storeSku],
      purchaseToken: fixture.token,
      orderId: fixture.transactionId,
      purchaseState: fixture.state,
      purchaseTime,
      isAcknowledged: false,
      quantity: 1,
      obfuscatedAccountId: context.playerId,
    };
  };
  const report = (fixture: CommerceConformancePurchaseFixture): void => {
    plugin.report(toPlayPurchase(fixture));
  };
  const actor: CommerceConformanceStoreActor = {
    get purchaseUiOpened() {
      return plugin.purchaseCalls.length;
    },
    get finishCalls() {
      // lifecycle.finish is 'server': the client has no finish surface at all.
      return [];
    },
    complete: report,
    update: report,
    error() {
      throw new Error(
        'The Play plugin has no purchase error event: a purchase call carries its own outcome.',
      );
    },
    queueRequest(result) {
      if (result.outcome === 'launched') {
        plugin.queuePurchase({
          throws: { code: 'PLAY_BILLING_TIMEOUT', message: 'Purchase confirmation timed out.' },
        });
      } else if (result.outcome === 'purchased') {
        plugin.queuePurchase({ status: 'purchased', purchase: toPlayPurchase(result.purchase) });
      } else {
        // A plugin rejection carrying the fixture's code; the SDK passes
        // `code`, `retryable`, and `storeCode` through to the provider.
        plugin.queuePurchase({
          throws: {
            code: result.error.code,
            retryable: result.error.retryable,
            ...(result.error.storeCode === undefined ? {} : { storeCode: result.error.storeCode }),
            message: `Fixture purchase failure: ${result.error.code}.`,
          },
        });
      }
    },
    queueFinish() {
      throw new Error('The Play client never finishes a transaction; the backend finalizer does.');
    },
    finalize(request) {
      const purchase = plugin.purchases.find((entry) => entry.orderId === request.transactionId);
      if (purchase === undefined) {
        return;
      }
      const kind = context.catalog.find((entry) => entry.storeSku === purchase.products[0])?.kind;
      plugin.finalize(purchase.purchaseToken, kind === 'durable' ? 'acknowledge' : 'consume');
    },
  };
  return { plugin, actor, accountBinding };
}

function vectorProducts(
  context: CommerceConformanceContext,
): readonly PlayBillingCommerceProductMapping[] {
  return context.catalog.map((entry) => {
    if (entry.kind === 'subscription') {
      throw new Error(`Play sells no subscriptions; ${entry.logicalId} cannot be mapped.`);
    }
    return { logicalId: entry.logicalId, storeSku: entry.storeSku, kind: entry.kind };
  });
}

function createVectorProvider(context: CommerceConformanceContext): {
  readonly provider: CommerceProvider;
  readonly store: CommerceConformanceStoreActor;
} {
  const { plugin, actor, accountBinding } = createConformancePlayPlugin(context);
  const provider = createCapacitorPlayBillingCommerceProvider({
    plugin,
    isAndroid: () => true,
    // The vector's expectations name its fixture store id; production keeps the default.
    store: context.profile.store,
    products: vectorProducts(context),
    accountBinding: () => accountBinding,
  });
  return { provider, store: actor };
}

function createBridgedVectorProvider(context: CommerceConformanceContext): CommerceConformanceHarness {
  const { plugin, actor, accountBinding } = createConformancePlayPlugin(context);
  const gateway = createCapacitorPlatformGateway({
    target: 'android',
    appVersion: '1.0.0',
    buildId: `conformance:${context.vector.vector}`,
    bridge: {
      async request(input: BridgeRequest): Promise<BridgeResponse> {
        throw new Error(`The base bridge must not receive ${input.method}.`);
      },
    },
    providers: [
      createCapacitorPlayBillingServiceProvider({
        plugin,
        isAndroid: () => true,
        store: context.profile.store,
        products: vectorProducts(context),
        accountBinding: () => accountBinding,
      }),
    ],
  });
  if (gateway.commerce === undefined) {
    throw new Error('The gateway must expose the registered commerce provider.');
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

/** The adaptive runs must have derived Play's server-finish shape, not the fixture's. */
function expectServerFinishDerivation(results: readonly CommerceConformanceVectorResult[]): void {
  for (const result of results) {
    if (result.status !== 'passed') {
      continue;
    }
    expect(result.adaptive?.finish, result.vector).toBe('server');
    expect(result.adaptive?.evidence, result.vector).toBe('client-token');
    expect(result.adaptive?.expect.finishCalls, result.vector).toEqual([]);
    expect(result.adaptive?.expect.available, result.vector).toEqual([]);
    const journal = Object.values(result.adaptive?.expect.journal ?? {});
    expect(journal.length, result.vector).toBeGreaterThan(0);
    for (const states of journal) {
      expect(states, result.vector).toContain('finished');
    }
  }
}

describe('Play Billing commerce provider conformance', () => {
  it('classifies every store vector against the google-play profile', () => {
    expect(storeVectors).toHaveLength(11);
    const skipped = Object.fromEntries(storeVectors.flatMap((vector) => {
      const reason = playBillingVectorIncompatibility(vector);
      return reason === undefined ? [] : [[vector.vector, reason]];
    }));
    expect(Object.keys(skipped).sort()).toEqual(Object.keys(expectedSkips).sort());
    for (const [vector, pattern] of Object.entries(expectedSkips)) {
      expect(skipped[vector], vector).toMatch(pattern);
    }
    expect(playVectors.map((vector) => vector.vector)).toEqual(
      expectedRunnerStatuses.map((entry) => entry.vector),
    );
    expect(playVectors.every(isAdaptiveCommerceConformanceVector)).toBe(true);
  });

  it('runs every Play-applicable vector against the fake plugin', async () => {
    const results = await runCommerceConformanceVectors(playVectors, {
      createProvider: createVectorProvider,
    });
    expect(summarize(results)).toEqual(expectedRunnerStatuses);
    expectServerFinishDerivation(results);
  });

  it('runs every Play-applicable vector through the gateway bridge path', async () => {
    const results = await runCommerceConformanceVectors(playVectors, {
      createProvider: createBridgedVectorProvider,
    });
    expect(summarize(results)).toEqual(expectedRunnerStatuses);
    expectServerFinishDerivation(results);
  });

  it('derives the finalization re-read for a vector written for a client-finish fixture', async () => {
    const vector = storeVectors.find((candidate) => candidate.vector === 'purchase-client-finish');
    if (vector === undefined) {
      throw new Error('Missing vector.');
    }
    // On its own the family member is not a duplicate; Play runs it with
    // server-finish expectations: no client finish call, and a second verify
    // request that reads finalization after the grant.
    const [result] = await runCommerceConformanceVectors([vector], {
      createProvider: createVectorProvider,
    });
    expect(result?.failures).toEqual([]);
    expect(result?.status).toBe('passed');
    expect(result?.adaptive?.expect.finishCalls).toEqual([]);
    expect(result?.adaptive?.expect.verifyRequests).toEqual([
      { idempotencyKey: 'op-1', store: vector.profile.store, transactionId: 'tx-1', token: 'token-1' },
      { idempotencyKey: 'op-1', store: vector.profile.store, transactionId: 'tx-1', token: 'token-1' },
    ]);
    expect(result?.adaptive?.expect.journal).toEqual({
      'op-1': ['requested', 'launched', 'purchased', 'verifying', 'granted', 'finishing', 'finished'],
    });
  });

  it('fails an applicable vector whose expectation the Play provider cannot meet', async () => {
    const vector = playVectors.find((candidate) => candidate.vector === 'purchase-server-finish');
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

  it('fails a profile-specific vector whose fixture profile Play does not match', async () => {
    const vector = storeVectors.find((candidate) => candidate.vector === 'server-push-settlement');
    if (vector === undefined) {
      throw new Error('Missing vector.');
    }
    // Not adaptive: the fixture's `finish: 'none'` expectations apply as
    // written, which is why the classification above keeps it out of the run.
    const [result] = await runCommerceConformanceVectors([vector], {
      createProvider: createVectorProvider,
    });
    expect(result?.status).toBe('failed');
    expect(result?.adaptive).toBeUndefined();
    expect(result?.failures.length).toBeGreaterThan(0);
  });
});
