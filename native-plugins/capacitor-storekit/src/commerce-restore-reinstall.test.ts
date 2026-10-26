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
  assertEqual,
  createFakeStoreKitPlugin,
  fakeProduct,
  fakeTransaction,
  type FakeStoreKitPlugin,
} from '../test/fake-storekit-plugin.js';
import { createCapacitorStoreKitCommerceProvider } from './commerce-provider.js';

/**
 * A reinstall (or a new iPhone or iPad) on the App Store, end to end: the
 * reconciler over the StoreKit provider and a fake plugin, the reference
 * backend over its in-memory store with restore sharing on, and a verifier
 * standing in for the App Store that knows which guest's appAccountToken each
 * transaction carries. Every earlier purchase carries the earlier guest's
 * token, so only the new guest's Restore Purchases read hands REMOVE_ADS to
 * the backend, as a restore, and the backend shares it.
 */

const removeAdsSku = 'com.example.game.removeads';
const hintsSku = 'com.example.game.hints5';
const catalog = {
  version: 'test',
  products: [
    {
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'remove_ads' },
      platformProductIds: { ios: removeAdsSku },
    },
    {
      id: 'HINT_PACK_5',
      type: 'consumable',
      grant: { type: 'resource', resource: 'hint', amount: 5 },
      platformProductIds: { ios: hintsSku },
    },
  ],
} as const;
const placements = { version: 'test', placements: [] } as const;
const products = [
  { logicalId: 'REMOVE_ADS', storeSku: removeAdsSku, kind: 'durable' as const },
  { logicalId: 'HINT_PACK_5', storeSku: hintsSku, kind: 'consumable' as const },
];

const earlierGuest = 'guest-before-reinstall';
/** Each guest's app account token (the reference backend derives one per player). */
const tokens = new Map<string, string>([
  [earlierGuest, '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'],
  ['guest-after-reinstall', '1b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e'],
  ['guest-second-device', '2c3d4e5f-6a7b-4c8d-ae9f-1a2b3c4d5e6f'],
  ['guest-third-device', '3d4e5f6a-7b8c-4d9e-bfa0-2b3c4d5e6f7a'],
]);
const tokenOf = (playerId: string): string => {
  const token = tokens.get(playerId);
  if (token === undefined) {
    throw new Error(`No app account token for ${playerId}.`);
  }
  return token;
};

interface World {
  readonly plugin: FakeStoreKitPlugin;
  readonly backend: GameServicesBackendApi;
  readonly store: ReturnType<typeof createInMemoryGameServicesStore>;
  /** Every request the backend received from a reconciler. */
  readonly requests: VerifyPurchaseRequest[];
}

/**
 * The Apple ID's transactions after a reinstall: REMOVE_ADS the earlier guest
 * bought (granted then, and finished, so a current entitlement with
 * `unfinished: false`) and a hint pack it bought that never finished.
 */
async function createWorld(maxHolders?: number): Promise<World> {
  const plugin = createFakeStoreKitPlugin({
    products: [
      fakeProduct({ productId: removeAdsSku, type: 'non_consumable' }),
      fakeProduct({ productId: hintsSku }),
    ],
    transactions: [
      fakeTransaction({
        transactionId: '3000000000000001',
        productId: removeAdsSku,
        type: 'non_consumable',
        appAccountToken: tokenOf(earlierGuest),
        unfinished: false,
      }),
      fakeTransaction({
        transactionId: '3000000000000002',
        productId: hintsSku,
        type: 'consumable',
        appAccountToken: tokenOf(earlierGuest),
        unfinished: true,
      }),
    ],
  });
  const store = createInMemoryGameServicesStore();
  const backend = createGameServicesBackend({
    catalog,
    placements,
    store,
    evidenceVerifier: {
      async verifyPurchase({ request, product }): Promise<EvidenceVerificationDecision> {
        const transaction = plugin.transactions.find(
          (candidate) => candidate.transactionId === request.platformTransactionId,
        );
        const verified = {
          verificationId: `app-store:${request.platformTransactionId}`,
          verifiedAt: '2030-01-01T00:00:00.000Z',
          platformEvidenceId: request.platformTransactionId,
        };
        if (transaction !== undefined && transaction.appAccountToken === tokenOf(request.playerId)) {
          return { status: 'verified', ...verified };
        }
        // The reference App Store verifier: only a restore of a
        // non-consumable may be answered across tokens.
        return request.intent === 'restore' && product.type === 'non_consumable'
          ? { status: 'restorable', reason: 'APP_STORE_ACCOUNT_TOKEN_MISMATCH', ...verified }
          : { status: 'rejected', reason: 'APP_STORE_ACCOUNT_TOKEN_MISMATCH' };
      },
      async verifyAdReward() {
        return { status: 'rejected', reason: 'UNUSED' };
      },
    },
    restoreSharing: { mode: 'share', ...(maxHolders === undefined ? {} : { maxHolders }) },
  });
  // The earlier install bought and was granted REMOVE_ADS.
  const bought = await backend.purchases.verifyPurchase({
    target: 'ios',
    store: 'app-store',
    playerId: earlierGuest,
    productId: 'REMOVE_ADS',
    platformTransactionId: '3000000000000001',
    idempotencyKey: 'earlier-install-remove-ads',
    purchasedAt: '2030-01-01T00:00:00.000Z',
  });
  assertEqual(bought.verified, true, 'the earlier guest holds REMOVE_ADS');
  return { plugin, backend, store, requests: [] };
}

/**
 * A fresh install's reconciler for `playerId`: an empty journal, the same
 * Apple ID. `journal` is the install's journal when the app relaunches or
 * another guest signs in on the same install.
 */
function install(
  world: World,
  playerId: string,
  journal: MonetizationOperationStore = createInMemoryMonetizationOperationStore(),
) {
  const provider = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => tokenOf(playerId),
    isIos: () => true,
    sdk: world.plugin,
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
    target: 'ios',
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

// Reinstall: Restore Purchases sends the earlier guest's REMOVE_ADS as a restore, the backend
// shares it, and the finish ends on the already finished entitlement.
{
  const world = await createWorld();
  const { reconciler, responses, failures } = install(world, 'guest-after-reinstall');

  await reconciler.start();
  assertEqual(
    world.requests,
    [],
    "startup recovery sends nothing bound to the earlier guest's token",
  );

  await reconciler.restorePurchases();
  assertEqual(
    world.requests.map((request) => [
      request.productId,
      request.intent,
      request.platformTransactionId,
    ]),
    [['REMOVE_ADS', 'restore', '3000000000000001']],
    "only REMOVE_ADS reaches the backend, as a restore; the earlier guest's consumable is never sent",
  );
  assertEqual(
    { verified: responses[0]?.verified, restoredAcrossPlayers: responses[0]?.restoredAcrossPlayers },
    { verified: true, restoredAcrossPlayers: true },
    'the backend shares the purchase with the new guest',
  );
  assertEqual(
    await holdersOf(world),
    [earlierGuest, 'guest-after-reinstall'].sort(),
    'both guests hold REMOVE_ADS',
  );
  assertEqual(
    await reconciler.listRecoverable(),
    [],
    'the shared purchase is finished: StoreKit already finished the entitlement',
  );
  assertEqual(
    world.plugin.calls.filter((call) => call.startsWith('finish:')),
    [],
    "the earlier guest's transactions never reach the native finish",
  );

  await reconciler.restorePurchases();
  assertEqual(world.requests.length, 1, 'a second restore of a held purchase sends nothing');
  const resent = await world.backend.purchases.verifyPurchase(
    world.requests[0] as VerifyPurchaseRequest,
  );
  assertEqual(
    { verified: resent.verified, alreadyProcessed: resent.alreadyProcessed },
    { verified: true, alreadyProcessed: true },
    'the backend answers a resend idempotently',
  );
  assertEqual((await holdersOf(world)).length, 2, 'a resend adds no holder');

  await reconciler.reconcile();
  assertEqual(world.requests.length, 1, 'a later reconcile keeps the startup filter');
  await reconciler.stop();
  assertEqual(failures, [], 'no reconciler stage failed');
}

// The holder limit: a third guest past `maxHolders: 2` is answered pending and evicts nobody.
{
  const world = await createWorld(2);
  const second = install(world, 'guest-second-device');
  await second.reconciler.start();
  await second.reconciler.restorePurchases();
  await second.reconciler.stop();
  assertEqual(
    await holdersOf(world),
    [earlierGuest, 'guest-second-device'].sort(),
    'the second device shares the purchase',
  );

  const third = install(world, 'guest-third-device');
  await third.reconciler.start();
  await third.reconciler.restorePurchases();
  const last = third.responses.at(-1);
  assertEqual(
    last?.verified === false ? [last.disposition, last.reason] : [],
    ['pending', 'PURCHASE_HOLDER_LIMIT_REACHED'],
    'the third guest is at the holder limit',
  );
  assertEqual(
    (await third.reconciler.listRecoverable()).map((record) => record.state),
    ['pending'],
    'the restore stays pending for the starter to report',
  );
  const sentAtLimit = world.requests.length;
  await third.reconciler.reconcile();
  await third.reconciler.stop();
  assertEqual(
    await holdersOf(world),
    [earlierGuest, 'guest-second-device'].sort(),
    'nobody is evicted',
  );

  // A relaunch and a resume never resend the restore at the holder limit.
  const relaunched = install(world, 'guest-third-device', third.journal);
  await relaunched.reconciler.start();
  await relaunched.reconciler.reconcile();
  assertEqual(
    world.requests.length,
    sentAtLimit,
    'only Restore Purchases asks the backend again at the holder limit',
  );

  // The second device's guest deletes its account, which frees its place; the
  // player's next Restore Purchases asks again and lands.
  await world.store.erasePlayerData({
    playerId: 'guest-second-device',
    retainedPlayerId: 'deleted:guest-second-device',
  });
  await relaunched.reconciler.restorePurchases();
  assertEqual(
    world.requests.length,
    sentAtLimit + 1,
    'Restore Purchases resends the saved request',
  );
  assertEqual(
    relaunched.responses.at(-1)?.restoredAcrossPlayers,
    true,
    'the freed place is shared with the third guest',
  );
  assertEqual(
    await relaunched.reconciler.listRecoverable(),
    [],
    'the restore finishes on the entitlement StoreKit already finished',
  );
  await relaunched.reconciler.stop();
  assertEqual(relaunched.failures, [], 'no reconciler stage failed after the relaunch');
}

console.log('StoreKit restore after a reinstall passed.');
