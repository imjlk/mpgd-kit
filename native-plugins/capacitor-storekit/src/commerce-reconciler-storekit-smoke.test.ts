import {
  createCommerceReconciler,
  createInMemoryMonetizationOperationStore,
  type CommerceReconcilerEvent,
} from '@mpgd/game-services';
import type { PurchaseVerificationApi } from '@mpgd/game-services/client';

import {
  assertEqual,
  createFakeStoreKitPlugin,
  fakeAccountToken,
  fakeProduct,
  fakeTransaction,
} from '../test/fake-storekit-plugin.js';
import { createCapacitorStoreKitCommerceProvider } from './commerce-provider.js';
import type { StoreKitTransaction } from './definitions.js';
import {
  createCapacitorStoreKitProvider,
  recoverStoreKitPurchases,
  type StoreKitPurchaseVerification,
} from './provider.js';

/**
 * The deprecated v1 recovery driver (`recoverStoreKitPurchases`) and the
 * commerce v2 reconciler (`createCommerceReconciler` over
 * `createCapacitorStoreKitCommerceProvider`) run the same unfinished
 * transactions against the same backend decisions through the same fake
 * plugin, and must reach the same outcome: a grant finishes with the ledger
 * entry, a rejection and an outage never finish, a failed finish is retried,
 * and another account's transaction is never submitted. The v2 StoreKit SDK
 * keeps no finish allow-list of its own: the reconciler is the finish gate.
 */

const storeSku = 'com.example.game.coins100';
const products = [{ logicalId: 'COINS_100', storeSku, kind: 'consumable' as const }];

type Decision =
  | { readonly verified: true; readonly ledgerEntryId: string }
  | { readonly verified: false; readonly disposition: 'rejected' | 'pending' }
  | { readonly throws: true };

function transactions(input: { readonly foreignAccount?: boolean } = {}): StoreKitTransaction[] {
  return [
    fakeTransaction({
      transactionId: '2000000123456789',
      unfinished: true,
      ...(input.foreignAccount === true
        ? { appAccountToken: 'a7e2f8a0-5d4e-4a3a-9c1b-2f1d2e3c4b5a' }
        : {}),
    }),
  ];
}

interface Outcome {
  readonly status: 'granted' | 'rejected' | 'pending' | 'none';
  readonly finished: boolean;
  readonly verified: number;
}

async function runLegacy(
  decision: Decision,
  input: { readonly foreignAccount?: boolean; readonly finishFails?: boolean } = {},
): Promise<Outcome> {
  const plugin = createFakeStoreKitPlugin({
    products: [fakeProduct({ productId: storeSku })],
    transactions: transactions(input),
  });
  if (input.finishFails === true) {
    plugin.queueFinish({ throws: new Error('finish failed') });
  }
  const provider = createCapacitorStoreKitProvider({
    products: [{ id: 'COINS_100', storeId: storeSku, type: 'consumable' }],
    getAppAccountToken: () => fakeAccountToken,
    isIos: () => true,
    sdk: plugin,
  });
  let verified = 0;
  const backend = {
    async recoverPurchase(): Promise<StoreKitPurchaseVerification> {
      verified += 1;
      if ('throws' in decision) {
        throw new Error('backend unavailable');
      }
      return decision.verified
        ? { verified: true, alreadyProcessed: false, ledgerEntryId: decision.ledgerEntryId }
        : { verified: false, alreadyProcessed: false, disposition: decision.disposition };
    },
  };
  const recovered = await recoverStoreKitPurchases({ provider, backend, playerId: 'player-1' });
  const first = recovered[0];
  const finished = plugin.calls.some((call) => call.startsWith('finish:'))
    && first?.status === 'granted' && first.finishPending !== true;
  return {
    status: first === undefined
      ? 'none'
      : first.reason === 'account-mismatch'
        ? 'none'
        : first.status,
    finished,
    verified,
  };
}

async function runReconciler(
  decision: Decision,
  input: { readonly foreignAccount?: boolean; readonly finishFails?: boolean } = {},
): Promise<Outcome & { readonly history: readonly string[]; readonly finishCalls: readonly string[] }> {
  const plugin = createFakeStoreKitPlugin({
    products: [fakeProduct({ productId: storeSku })],
    transactions: transactions(input),
  });
  if (input.finishFails === true) {
    plugin.queueFinish({ throws: Object.assign(new Error('finish failed'), { code: 'NETWORK' }) });
  }
  const provider = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    isIos: () => true,
    sdk: plugin,
  });
  let verified = 0;
  const backend: PurchaseVerificationApi = {
    async verifyPurchase() {
      verified += 1;
      if ('throws' in decision) {
        throw new Error('backend unavailable');
      }
      return decision.verified
        ? { verified: true, alreadyProcessed: false, ledgerEntryId: decision.ledgerEntryId }
        : { verified: false, alreadyProcessed: false, disposition: decision.disposition };
    },
  };
  const history: string[] = [];
  const reconciler = createCommerceReconciler({
    provider,
    backend,
    store: createInMemoryMonetizationOperationStore(),
    playerId: 'player-1',
    target: 'ios',
    products,
    onEvent(event: CommerceReconcilerEvent) {
      if (event.type === 'transition') {
        history.push(event.record.state);
      }
    },
  });
  await reconciler.start();
  const record = await reconciler.read('store:app-store:2000000123456789');
  await reconciler.stop();
  const finishCalls = plugin.calls.filter((call) => call.startsWith('finish:'));
  const state = record?.state;
  return {
    status: state === undefined
      ? 'none'
      : state === 'finished' || state === 'finishing' || state === 'granted'
        ? 'granted'
        : state === 'rejected'
          ? 'rejected'
          : 'pending',
    finished: state === 'finished',
    verified,
    history,
    finishCalls,
  };
}

const grant: Decision = { verified: true, ledgerEntryId: 'ledger-1' };

// A grant finishes with the ledger entry id on both paths.
{
  const legacy = await runLegacy(grant);
  const v2 = await runReconciler(grant);
  assertEqual(
    legacy,
    { status: 'granted', finished: true, verified: 1 },
    'v1: granted and finished',
  );
  assertEqual(
    { status: v2.status, finished: v2.finished, verified: v2.verified },
    legacy,
    'v2: the same outcome',
  );
  assertEqual(
    v2.history,
    ['purchased', 'verifying', 'granted', 'finishing', 'finished'],
    'v2: the discovered transaction moves through the RFC states',
  );
  assertEqual(
    v2.finishCalls,
    ['finish:2000000123456789:ledger-1'],
    'v2: finished once with the ledger entry the backend returned',
  );
}

// A rejection never finishes on either path.
{
  const rejected: Decision = { verified: false, disposition: 'rejected' };
  const legacy = await runLegacy(rejected);
  const v2 = await runReconciler(rejected);
  assertEqual(legacy, { status: 'rejected', finished: false, verified: 1 }, 'v1: rejected');
  assertEqual(
    { status: v2.status, finished: v2.finished, verified: v2.verified },
    legacy,
    'v2: rejected',
  );
  assertEqual(v2.finishCalls, [], 'v2: no finish without a grant');
}

// A backend outage stays retryable on both paths; nothing is finished.
{
  const outage: Decision = { throws: true };
  const legacy = await runLegacy(outage);
  const v2 = await runReconciler(outage);
  assertEqual(legacy, { status: 'pending', finished: false, verified: 1 }, 'v1: pending');
  assertEqual(
    { status: v2.status, finished: v2.finished, verified: v2.verified },
    legacy,
    'v2: pending',
  );
  assertEqual(v2.history, ['purchased', 'verifying'], 'v2: verifying is kept for the next pass');
}

// A failed native finish keeps the grant and the finish pending on both paths.
{
  const legacy = await runLegacy(grant, { finishFails: true });
  const v2 = await runReconciler(grant, { finishFails: true });
  assertEqual(
    legacy,
    { status: 'granted', finished: false, verified: 1 },
    'v1: granted, finish pending',
  );
  assertEqual(
    { status: v2.status, finished: v2.finished, verified: v2.verified },
    legacy,
    'v2: granted, finish pending',
  );
  assertEqual(v2.history.at(-1), 'finishing', 'v2: finishing is retried on the next pass');
  assertEqual(
    v2.finishCalls,
    ['finish:2000000123456789:ledger-1'],
    'v2: the finish was attempted once',
  );
}

// Another account's transaction is never submitted on either path.
{
  const legacy = await runLegacy(grant, { foreignAccount: true });
  const v2 = await runReconciler(grant, { foreignAccount: true });
  assertEqual(
    legacy,
    { status: 'none', finished: false, verified: 0 },
    'v1: account mismatch is rejected without a backend call',
  );
  assertEqual(
    { status: v2.status, finished: v2.finished, verified: v2.verified },
    legacy,
    'v2: the SDK keeps the transaction away from the reconciler',
  );
  assertEqual(v2.history, [], 'v2: no journal record');
}

console.info('StoreKit v1 driver and commerce v2 reconciler smoke parity passed.');
