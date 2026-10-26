import { describe, expect, it } from 'vitest';

import {
  createCommerceReconciler,
  createInMemoryMonetizationOperationStore,
  type CommerceReconcilerEvent,
  type EvidenceVerificationDecision,
  type GameServicesBackendApi,
  type MonetizationOperationStore,
} from '@mpgd/game-services';
import {
  createGameServicesBackend,
  createInMemoryGameServicesStore,
  listActiveEntitlementTransactions,
} from '@mpgd/game-services/server';
import type { VerifyPurchaseRequest, VerifyPurchaseResponse } from '@mpgd/game-services/types';

import {
  createFakePlayBillingPlugin,
  fakePlayProduct,
  fakePlayPurchase,
  type FakePlayBillingPlugin,
} from '../test/play-billing-plugin-fixture.js';
import { createCapacitorPlayBillingCommerceProvider } from './commerce-provider.js';

/**
 * A reinstall on Google Play, end to end: the reconciler over the Play
 * provider and a fake plugin, the reference backend over its in-memory store
 * with restore sharing on, and a verifier standing in for Google Play that
 * knows which guest bought each purchase. The earlier guest's REMOVE_ADS was
 * acknowledged at its first purchase, so it is never unfinished again: only
 * the new guest's Restore Purchases read hands it to the backend, as a
 * restore, and the backend shares it.
 */

const catalog = {
  version: 'test',
  products: [
    {
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'remove_ads' },
      platformProductIds: { android: 'remove_ads' },
    },
    {
      id: 'HINT_PACK_5',
      type: 'consumable',
      grant: { type: 'resource', resource: 'hint', amount: 5 },
      platformProductIds: { android: 'hint_pack_5' },
    },
  ],
} as const;
const placements = { version: 'test', placements: [] } as const;
const products = [
  { logicalId: 'REMOVE_ADS', storeSku: 'remove_ads', kind: 'durable' as const },
  { logicalId: 'HINT_PACK_5', storeSku: 'hint_pack_5', kind: 'consumable' as const },
];

const earlierGuest = 'guest-before-reinstall';

interface World {
  readonly plugin: FakePlayBillingPlugin;
  readonly backend: GameServicesBackendApi;
  readonly store: ReturnType<typeof createInMemoryGameServicesStore>;
  /** Every request the backend received from a reconciler. */
  readonly requests: VerifyPurchaseRequest[];
}

/**
 * The store account's purchases after a reinstall: REMOVE_ADS the earlier
 * guest bought (granted and acknowledged by the backend then) and a hint
 * pack it bought whose acknowledgement landed but whose consume never did.
 */
async function createWorld(maxHolders?: number): Promise<World> {
  const plugin = createFakePlayBillingPlugin({
    products: [
      fakePlayProduct({ productId: 'remove_ads' }),
      fakePlayProduct({ productId: 'hint_pack_5' }),
    ],
  });
  /** What Google Play knows: the guest whose obfuscated account id each order carries. */
  const buyers = new Map<string, string>([
    ['GPA.ads', earlierGuest],
    ['GPA.hints', earlierGuest],
  ]);
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: {
      async verifyPurchase({ request, product }): Promise<EvidenceVerificationDecision> {
        const verified = {
          verificationId: `google-play:product:${request.platformTransactionId}`,
          verifiedAt: '2030-01-01T00:00:00.000Z',
          platformEvidenceId: request.platformTransactionId,
        };
        if (buyers.get(request.platformTransactionId) === request.playerId) {
          return { status: 'verified', ...verified };
        }
        // The reference Play boundary: only a restore of a non-consumable may
        // be answered across accounts.
        return request.intent === 'restore' && product.type === 'non_consumable'
          ? { status: 'restorable', reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH', ...verified }
          : { status: 'rejected', reason: 'GOOGLE_PLAY_ACCOUNT_MISMATCH' };
      },
      async verifyAdReward() {
        return { status: 'rejected', reason: 'UNUSED' };
      },
    },
    purchaseGrantFinalizer: {
      async finalizePurchaseGrant(input) {
        return { status: 'completed', action: 'acknowledge', alreadyCompleted: input.alreadyProcessed };
      },
    },
    restoreSharing: { mode: 'share', ...(maxHolders === undefined ? {} : { maxHolders }) },
  });
  // The earlier install bought and was granted REMOVE_ADS; the backend acknowledged it.
  const bought = await backend.purchases.verifyPurchase({
    target: 'android',
    store: 'google-play',
    playerId: earlierGuest,
    productId: 'REMOVE_ADS',
    platformTransactionId: 'GPA.ads',
    idempotencyKey: 'earlier-install-remove-ads',
    purchasedAt: '2030-01-01T00:00:00.000Z',
  });
  expect(bought.verified).toBe(true);
  plugin.upsert(
    fakePlayPurchase({
      purchaseToken: 'token-ads',
      products: ['remove_ads'],
      orderId: 'GPA.ads',
      isAcknowledged: true,
      obfuscatedAccountId: earlierGuest,
    }),
  );
  plugin.upsert(
    fakePlayPurchase({
      purchaseToken: 'token-hints',
      products: ['hint_pack_5'],
      orderId: 'GPA.hints',
      isAcknowledged: true,
      obfuscatedAccountId: earlierGuest,
    }),
  );
  return { plugin, backend, store, requests: [] };
}

/**
 * A fresh install's reconciler for `playerId`: an empty journal, the same
 * store account. `journal` is the install's journal when the app relaunches
 * or another guest signs in on the same install.
 */
function install(
  world: World,
  playerId: string,
  journal: MonetizationOperationStore = createInMemoryMonetizationOperationStore(),
) {
  const provider = createCapacitorPlayBillingCommerceProvider({
    plugin: world.plugin,
    isAndroid: () => true,
    products,
    accountBinding: () => ({ kind: 'obfuscated-account-id', value: playerId }),
  });
  const responses: VerifyPurchaseResponse[] = [];
  const failures: string[] = [];
  const reconciler = createCommerceReconciler({
    provider,
    backend: {
      async verifyPurchase(request) {
        world.requests.push(request);
        const response = await world.backend.purchases.verifyPurchase(request);
        responses.push(response);
        return response;
      },
    },
    store: journal,
    playerId,
    target: 'android',
    products,
    onEvent(event: CommerceReconcilerEvent) {
      if (event.type === 'failure') {
        failures.push(event.stage);
      }
    },
  });
  return { reconciler, responses, failures, journal };
}

/** The players holding an active REMOVE_ADS grant (the only entitlement in this catalog). */
async function holdersOf(world: World): Promise<readonly string[]> {
  return (await listActiveEntitlementTransactions(world.store))
    .map((grant) => grant.playerId)
    .sort();
}

describe('Play Billing restore after a reinstall', () => {
  it('sends the acknowledged durable on Restore Purchases only, and the backend shares it', async () => {
    const world = await createWorld();
    const { reconciler, responses, failures } = install(world, 'guest-after-reinstall');

    // Startup recovery keeps today's filter: nothing acknowledged is sent.
    await reconciler.start();
    expect(world.requests).toEqual([]);

    await reconciler.restorePurchases();
    // Only REMOVE_ADS reaches the backend, as a restore; the acknowledged
    // consumable is never sent.
    expect(world.requests.map((request) => [request.productId, request.intent, request.platformTransactionId]))
      .toEqual([['REMOVE_ADS', 'restore', 'GPA.ads']]);
    expect(responses[0]).toMatchObject({ verified: true, restoredAcrossPlayers: true });
    expect(await holdersOf(world)).toEqual([earlierGuest, 'guest-after-reinstall'].sort());
    const [summary] = await reconciler.listRecoverable();
    expect(summary).toBeUndefined();

    // A second restore of a purchase this guest already holds sends nothing:
    // the journal holds it finished.
    await reconciler.restorePurchases();
    expect(world.requests).toHaveLength(1);
    // The backend answers a resend idempotently, without another holder.
    const resent = await world.backend.purchases.verifyPurchase(world.requests[0] as VerifyPurchaseRequest);
    expect(resent).toMatchObject({ verified: true, alreadyProcessed: true });
    expect(await holdersOf(world)).toHaveLength(2);

    // A later launch of the same install keeps the startup filter.
    await reconciler.reconcile();
    expect(world.requests).toHaveLength(1);
    await reconciler.stop();
    expect(failures).toEqual([]);
  });

  it('answers the holder limit without granting or evicting anyone', async () => {
    const world = await createWorld(2);
    const second = install(world, 'guest-second-device');
    await second.reconciler.start();
    await second.reconciler.restorePurchases();
    await second.reconciler.stop();
    expect(await holdersOf(world)).toEqual([earlierGuest, 'guest-second-device'].sort());

    const third = install(world, 'guest-third-device');
    await third.reconciler.start();
    await third.reconciler.restorePurchases();
    expect(third.responses.at(-1)).toMatchObject({
      verified: false,
      disposition: 'pending',
      reason: 'PURCHASE_HOLDER_LIMIT_REACHED',
    });
    const [pending] = await third.reconciler.listRecoverable();
    expect(pending?.state).toBe('pending');
    const sentAtLimit = world.requests.length;
    await third.reconciler.reconcile();
    await third.reconciler.stop();
    expect(await holdersOf(world)).toEqual([earlierGuest, 'guest-second-device'].sort());

    // A relaunch and a resume never resend the restore at the holder limit.
    const relaunched = install(world, 'guest-third-device', third.journal);
    await relaunched.reconciler.start();
    await relaunched.reconciler.reconcile();
    expect(world.requests).toHaveLength(sentAtLimit);

    // The second device's guest deletes its account, which frees its place;
    // the player's next Restore Purchases asks again and lands.
    await world.store.erasePlayerData({
      playerId: 'guest-second-device',
      retainedPlayerId: 'deleted:guest-second-device',
    });
    await relaunched.reconciler.restorePurchases();
    expect(world.requests).toHaveLength(sentAtLimit + 1);
    expect(relaunched.responses.at(-1)).toMatchObject({ verified: true, restoredAcrossPlayers: true });
    expect(await relaunched.reconciler.listRecoverable()).toEqual([]);
    await relaunched.reconciler.stop();
    expect(relaunched.failures).toEqual([]);
  });
});
