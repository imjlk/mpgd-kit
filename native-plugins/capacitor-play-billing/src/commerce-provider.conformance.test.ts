/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { BridgeRequest, BridgeResponse } from '@mpgd/bridge';
import { createCapacitorPlatformGateway } from '@mpgd/adapter-capacitor';
import type { CommerceProvider, StorePurchaseAccountBinding } from '@mpgd/platform/commerce';
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
 * Why the real Play provider cannot serve a vector profile, or `undefined`
 * when it can. The runner has no profile matching of its own: it drives
 * whatever provider `createProvider` returns and compares against
 * expectations written for the vector's profile, so a profile whose finish
 * owner, evidence authority, or product kinds differ from the Play
 * capabilities would fail on those expectations rather than be reported as
 * not applicable.
 */
export function playBillingVectorIncompatibility(
  profile: CommerceConformanceProfile,
): string | undefined {
  const capabilities = createCommerceConformanceCapabilities(profile);
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

const expectedSkips: Readonly<Record<string, RegExp>> = {
  'adapter-settled': /^authority\.evidence 'adapter-settled'/u,
  'cancelled-and-failed': /^lifecycle\.finish 'client'/u,
  'event-before-listener': /^lifecycle\.finish 'client'/u,
  'finish-failure-retry': /^lifecycle\.finish 'client'/u,
  'purchase-client-finish': /^lifecycle\.finish 'client'/u,
  'purchase-host-finish': /^lifecycle\.finish 'host'/u,
  'purchase-pending-then-purchased': /^lifecycle\.finish 'client'/u,
  'restart-before-verify': /^lifecycle\.finish 'client'/u,
  'revoked-after-grant': /^lifecycle\.finish 'client'/u,
  'server-push-settlement': /^lifecycle\.finish 'none'/u,
};
const playVectors = storeVectors.filter(
  (vector) => playBillingVectorIncompatibility(vector.profile) === undefined,
);

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
      productIds: [fixture.storeSku],
      purchaseToken: fixture.token,
      orderId: fixture.transactionId,
      purchaseState: fixture.state,
      state: fixture.state,
      purchaseTime,
      purchaseTimeMillis: purchaseTime,
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
  if (gateway.commerceV2 === undefined) {
    throw new Error('The gateway must expose the registered commerce v2 provider.');
  }
  return { provider: gateway.commerceV2, store: actor };
}

describe('Play Billing commerce provider conformance', () => {
  it('classifies every store vector against the google-play profile', () => {
    expect(storeVectors).toHaveLength(11);
    const skipped = Object.fromEntries(storeVectors.flatMap((vector) => {
      const reason = playBillingVectorIncompatibility(vector.profile);
      return reason === undefined ? [] : [[vector.vector, reason]];
    }));
    expect(Object.keys(skipped).sort()).toEqual(Object.keys(expectedSkips).sort());
    for (const [vector, pattern] of Object.entries(expectedSkips)) {
      expect(skipped[vector], vector).toMatch(pattern);
    }
    expect(playVectors.map((vector) => vector.vector)).toEqual(['purchase-server-finish']);
  });

  it('passes every Play-compatible vector against the fake plugin', async () => {
    const results = await runCommerceConformanceVectors(playVectors, {
      createProvider: createVectorProvider,
    });
    expect(results.map((result) => ({
      vector: result.vector, passed: result.passed, failures: result.failures,
    }))).toEqual(playVectors.map((vector) => ({
      vector: vector.vector, passed: true, failures: [],
    })));
  });

  it('passes every Play-compatible vector through the gateway bridge path', async () => {
    const results = await runCommerceConformanceVectors(playVectors, {
      createProvider: createBridgedVectorProvider,
    });
    expect(results.map((result) => ({
      vector: result.vector, passed: result.passed, failures: result.failures,
    }))).toEqual(playVectors.map((vector) => ({
      vector: vector.vector, passed: true, failures: [],
    })));
  });

  it('fails a compatible vector whose expectation the Play provider cannot meet', async () => {
    const vector = playVectors.find((candidate) => candidate.vector === 'purchase-server-finish');
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

  it('cannot pass a client-finish vector, which is why those are skipped', async () => {
    const vector = storeVectors.find((candidate) => candidate.vector === 'purchase-client-finish');
    if (vector === undefined) {
      throw new Error('Missing vector.');
    }
    const [result] = await runCommerceConformanceVectors([vector], {
      createProvider: createVectorProvider,
    });
    // The server-owned finish asks the backend again instead of calling the
    // client, so the vector's finishCalls and finished-state expectations fail.
    expect(result?.passed).toBe(false);
    expect(result?.failures.length).toBeGreaterThan(0);
  });
});
