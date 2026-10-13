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

/**
 * The commerce reconciler (`createCommerceReconciler` over
 * `createCapacitorStoreKitCommerceProvider`) runs unfinished transactions of a
 * fake plugin against scripted backend decisions: a grant finishes with the
 * ledger entry, a rejection and an outage never finish, a failed finish is
 * retried, and another account's transaction is never submitted. The StoreKit
 * SDK keeps no finish allow-list of its own: the reconciler is the finish gate.
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

// A grant finishes with the ledger entry id.
{
  const outcome = await runReconciler(grant);
  assertEqual(
    { status: outcome.status, finished: outcome.finished, verified: outcome.verified },
    { status: 'granted', finished: true, verified: 1 },
    'granted and finished',
  );
  assertEqual(
    outcome.history,
    ['purchased', 'verifying', 'granted', 'finishing', 'finished'],
    'the discovered transaction moves through the RFC states',
  );
  assertEqual(
    outcome.finishCalls,
    ['finish:2000000123456789:ledger-1'],
    'finished once with the ledger entry the backend returned',
  );
}

// A rejection never finishes.
{
  const rejected: Decision = { verified: false, disposition: 'rejected' };
  const outcome = await runReconciler(rejected);
  assertEqual(
    { status: outcome.status, finished: outcome.finished, verified: outcome.verified },
    { status: 'rejected', finished: false, verified: 1 },
    'rejected',
  );
  assertEqual(outcome.finishCalls, [], 'no finish without a grant');
}

// A backend outage stays retryable; nothing is finished.
{
  const outage: Decision = { throws: true };
  const outcome = await runReconciler(outage);
  assertEqual(
    { status: outcome.status, finished: outcome.finished, verified: outcome.verified },
    { status: 'pending', finished: false, verified: 1 },
    'pending',
  );
  assertEqual(outcome.history, ['purchased', 'verifying'], 'verifying is kept for the next pass');
}

// A failed native finish keeps the grant and the finish pending.
{
  const outcome = await runReconciler(grant, { finishFails: true });
  assertEqual(
    { status: outcome.status, finished: outcome.finished, verified: outcome.verified },
    { status: 'granted', finished: false, verified: 1 },
    'granted, finish pending',
  );
  assertEqual(outcome.history.at(-1), 'finishing', 'finishing is retried on the next pass');
  assertEqual(
    outcome.finishCalls,
    ['finish:2000000123456789:ledger-1'],
    'the finish was attempted once',
  );
}

// Another account's transaction is never submitted.
{
  const outcome = await runReconciler(grant, { foreignAccount: true });
  assertEqual(
    { status: outcome.status, finished: outcome.finished, verified: outcome.verified },
    { status: 'none', finished: false, verified: 0 },
    'the SDK keeps the transaction away from the reconciler',
  );
  assertEqual(outcome.history, [], 'no journal record');
}

console.info('StoreKit commerce reconciler smoke passed.');
