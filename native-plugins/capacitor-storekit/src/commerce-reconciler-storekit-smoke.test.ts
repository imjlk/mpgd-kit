import {
  createCommerceReconciler,
  createInMemoryMonetizationOperationStore,
  type CommerceReconcilerEvent,
  type MonetizationOperationStore,
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
import { revokedLedgerEntryIdPrefix } from './store-sdk.js';
import type { StoreKitTransaction } from './definitions.js';

/**
 * The commerce reconciler (`createCommerceReconciler` over
 * `createCapacitorStoreKitCommerceProvider`) runs unfinished transactions of a
 * fake plugin against scripted backend decisions: a grant finishes with the
 * ledger entry, a rejection and an outage never finish, a failed finish is
 * retried, and another account's transaction is never submitted. The StoreKit
 * SDK keeps no finish allow-list of its own: the reconciler is the finish gate.
 * A finish whose answer was lost after StoreKit applied it ends `finished` on
 * the next run, a transaction StoreKit lists again later is finished again
 * without a second verify, a first finish of a transaction the list does not
 * carry yet is refused and retried, and an Ask to Buy purchase finishes once
 * approved.
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
    ['finish:2000000123456789:ledger-1:' + fakeAccountToken],
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
    ['finish:2000000123456789:ledger-1:' + fakeAccountToken],
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

// A lost acknowledgement, a transaction StoreKit lists again, and Ask to Buy, over one journal.
{
  const transactionId = '2000000123456790';
  const plugin = createFakeStoreKitPlugin({
    products: [fakeProduct({ productId: storeSku })],
    transactions: [fakeTransaction({ transactionId, unfinished: true })],
  });
  const nativeFinish = plugin.finishTransaction.bind(plugin);
  let loseNextAnswer = true;
  plugin.finishTransaction = async (input) => {
    const result = await nativeFinish(input);
    if (loseNextAnswer) {
      // StoreKit finished the transaction; the app was closed before the
      // answer reached the journal.
      loseNextAnswer = false;
      throw Object.assign(new Error('bridge closed'), { code: 'NETWORK' });
    }
    return result;
  };
  const provider = createCapacitorStoreKitCommerceProvider({
    products,
    getAppAccountToken: () => fakeAccountToken,
    isIos: () => true,
    sdk: plugin,
  });
  const verifiedKeys: string[] = [];
  const backend: PurchaseVerificationApi = {
    async verifyPurchase(request) {
      verifiedKeys.push(request.idempotencyKey);
      return {
        verified: true,
        alreadyProcessed: false,
        ledgerEntryId: `ledger-${request.platformTransactionId}`,
      };
    },
  };
  const journal = createInMemoryMonetizationOperationStore();
  const run = (store: MonetizationOperationStore) =>
    createCommerceReconciler({
      provider,
      backend,
      store,
      playerId: 'player-1',
      target: 'ios',
      products,
      retryIntervalMs: 0,
    });
  const finishCalls = (): string[] => plugin.calls.filter((call) => call.startsWith('finish:'));
  const discovered = `store:app-store:${transactionId}`;

  const first = run(journal);
  await first.start();
  assertEqual(
    (await first.read(discovered))?.state,
    'finishing',
    'the lost answer leaves the grant finishing',
  );
  await first.stop();
  assertEqual(plugin.transactions, [], 'StoreKit finished it all the same');

  const second = run(journal);
  await second.start();
  assertEqual(
    (await second.read(discovered))?.state,
    'finished',
    'the next run reads the consumable off the unfinished list and ends the record',
  );
  assertEqual(finishCalls().length, 1, 'without a second native finish');
  assertEqual(verifiedKeys, [discovered], 'and without a second verify');

  // StoreKit lists it again (an entry the earlier read skipped as unverifiable,
  // or a list read before StoreKit carried it): it is finished again with the
  // journaled ledger entry, never verified or granted again.
  plugin.report(fakeTransaction({ transactionId, unfinished: true }));
  await second.runUntilIdle();
  assertEqual(
    finishCalls(),
    [
      `finish:${transactionId}:ledger-${transactionId}:${fakeAccountToken}`,
      `finish:${transactionId}:ledger-${transactionId}:${fakeAccountToken}`,
    ],
    'the transaction listed again is finished with the same ledger entry',
  );
  assertEqual(plugin.transactions, [], 'and leaves the unfinished list');
  assertEqual(verifiedKeys, [discovered], 'the ledger is asked once in all');
  assertEqual((await second.read(discovered))?.state, 'finished', 'the record stays finished');

  // A transaction delivered before StoreKit's unfinished list carries it: the
  // first finish after the grant is refused (never read as a lost
  // acknowledgement), and the retry finishes it natively once it is listed.
  const earlyId = '2000000123456792';
  plugin.emit(fakeTransaction({ transactionId: earlyId, unfinished: true }));
  await second.runUntilIdle();
  const early = `store:app-store:${earlyId}`;
  assertEqual(
    (await second.read(early))?.state,
    'finishing',
    'the first finish of an unlisted transaction leaves the grant finishing',
  );
  assertEqual(finishCalls().length, 2, 'and calls no native finish for it');
  plugin.upsert(fakeTransaction({ transactionId: earlyId, unfinished: true }));
  await second.reconcile();
  assertEqual((await second.read(early))?.state, 'finished', 'the retry finishes it');
  assertEqual(
    finishCalls().at(-1),
    `finish:${earlyId}:ledger-${earlyId}:${fakeAccountToken}`,
    'natively, with its ledger entry',
  );
  assertEqual(plugin.transactions, [], 'and it leaves the unfinished list');

  // Ask to Buy: no transaction exists until approval, so nothing is finished
  // before it; the approved transaction is verified and finished once.
  const launched = await second.requestPurchase({
    logicalId: 'COINS_100',
    idempotencyKey: 'ask-to-buy-1',
    source: 'shop',
  });
  assertEqual(launched.outcome, 'launched', 'Ask to Buy answers launched');
  assertEqual(
    (await second.read('ask-to-buy-1'))?.state,
    'launched',
    'and leaves the attempt launched',
  );
  await second.runUntilIdle();
  assertEqual(finishCalls().length, 3, 'nothing is finished while the parent decides');
  const approvedId = '2000000123456791';
  plugin.report(fakeTransaction({ transactionId: approvedId, unfinished: true }));
  await second.runUntilIdle();
  assertEqual(
    (await second.read('ask-to-buy-1'))?.state,
    'finished',
    'the approved purchase is granted and finished under the game key',
  );
  assertEqual(verifiedKeys, [discovered, early, 'ask-to-buy-1'], 'verified once');
  assertEqual(
    finishCalls().at(-1),
    `finish:${approvedId}:ledger-${approvedId}:${fakeAccountToken}`,
    'finished once with its ledger entry',
  );
  await second.stop();
}

// A consumable the App Store refunded while it was still unfinished, across
// launches, over the real provider and SDK: StoreKit keeps it in
// `Transaction.unfinished` and the provider lists it as revoked. Once the
// backend has answered for it without a standing grant (the ledger reversed
// the grant; or the verify was refused), the reconciler finishes it natively
// with the revoked flag, granting nothing, and StoreKit stops redelivering
// it. While the grant stands, it stays unfinished. A native build from before
// the revoked finish leaves it unfinished (today's behaviour); another
// token's revoked consumable never reaches the reconciler.
{
  const refunded = '2026-07-18T00:00:00Z';
  const grantedId = '2000000123456793';
  const refusedId = '2000000123456794';
  const foreignId = '2000000123456795';
  const foreignToken = 'a7e2f8a0-5d4e-4a3a-9c1b-2f1d2e3c4b5a';
  const setup = (native: 'supported' | 'ignored') => {
    const plugin = createFakeStoreKitPlugin({
      products: [fakeProduct({ productId: storeSku })],
      revokedFinish: native,
      transactions: [
        fakeTransaction({ transactionId: grantedId, unfinished: true }),
        fakeTransaction({ transactionId: refusedId, unfinished: true }),
      ],
    });
    const provider = createCapacitorStoreKitCommerceProvider({
      products,
      getAppAccountToken: () => fakeAccountToken,
      isIos: () => true,
      sdk: plugin,
    });
    const reversed = new Set<string>();
    const verified: string[] = [];
    let backendUp = true;
    const backend: PurchaseVerificationApi = {
      async verifyPurchase(request) {
        verified.push(request.platformTransactionId);
        if (request.platformTransactionId === grantedId) {
          return { verified: true, alreadyProcessed: false, ledgerEntryId: 'ledger-granted' };
        }
        if (!backendUp) {
          throw new Error('backend unavailable');
        }
        // The reference App Store verifier refuses a revoked transaction.
        return {
          verified: false,
          alreadyProcessed: false,
          disposition: 'rejected',
          reason: 'APP_STORE_TRANSACTION_REVOKED',
        };
      },
      async getPurchaseLedgerStatus(input) {
        return {
          statuses: input.ledgerEntryIds.map((ledgerEntryId) =>
            reversed.has(ledgerEntryId)
              ? { ledgerEntryId, status: 'reversed' as const, reversedBy: `${ledgerEntryId}-refund` }
              : { ledgerEntryId, status: 'active' as const }),
        };
      },
    };
    const journal = createInMemoryMonetizationOperationStore();
    const failures: string[] = [];
    const run = () =>
      createCommerceReconciler({
        provider,
        backend,
        store: journal,
        playerId: 'player-1',
        target: 'ios',
        products,
        retryIntervalMs: 0,
        onEvent(event: CommerceReconcilerEvent) {
          if (event.type === 'failure') {
            failures.push(`${event.stage}:${event.idempotencyKey ?? ''}`);
          }
        },
      });
    return {
      plugin,
      run,
      reversed,
      verified,
      failures,
      setBackendUp(value: boolean) {
        backendUp = value;
      },
      finishCalls: () => plugin.calls.filter((call) => call.startsWith('finish:')),
    };
  };
  const grantedKey = `store:app-store:${grantedId}`;
  const refusedKey = `store:app-store:${refusedId}`;

  const world = setup('supported');
  world.setBackendUp(false);
  // The first launch grants one transaction, whose finish is lost (the app
  // closes), and cannot reach the backend for the other.
  world.plugin.queueFinish({ throws: Object.assign(new Error('app closed'), { code: 'NETWORK' }) });
  const first = world.run();
  await first.start();
  assertEqual(
    [(await first.read(grantedKey))?.state, (await first.read(refusedKey))?.state],
    ['finishing', 'verifying'],
    'one grant waits for its finish, the other purchase for the backend',
  );
  await first.stop();

  // The App Store refunds both while they are unfinished (and a foreign
  // guest's consumable on the device too).
  world.plugin.upsert(
    fakeTransaction({ transactionId: grantedId, unfinished: true, revokedAt: refunded }),
  );
  world.plugin.upsert(
    fakeTransaction({ transactionId: refusedId, unfinished: true, revokedAt: refunded }),
  );
  world.plugin.upsert(
    fakeTransaction({
      transactionId: foreignId,
      unfinished: true,
      revokedAt: refunded,
      appAccountToken: foreignToken,
    }),
  );
  world.setBackendUp(true);

  // The next launch: the ledger has not recorded the granted one's refund yet.
  const second = world.run();
  await second.start();
  assertEqual(
    [(await second.read(grantedKey))?.state, (await second.read(refusedKey))?.state],
    ['finishing', 'rejected'],
    'the grant still stands; the backend refused the other',
  );
  assertEqual(
    world.finishCalls(),
    [
      `finish:${grantedId}:ledger-granted:${fakeAccountToken}`,
      `finish:${refusedId}:${revokedLedgerEntryIdPrefix}${refusedId}:${fakeAccountToken}:revoked`,
    ],
    'only the refused one is finished, as revoked and naming no ledger entry; the granted one stays unfinished',
  );

  // The ledger records the refund (App Store Server Notifications REFUND).
  world.reversed.add('ledger-granted');
  await second.reconcile();
  assertEqual((await second.read(grantedKey))?.state, 'revoked', 'the grant is revoked');
  assertEqual(
    world.finishCalls().at(-1),
    `finish:${grantedId}:ledger-granted:${fakeAccountToken}:revoked`,
    'then its transaction is finished as revoked, naming the reversed grant',
  );
  assertEqual(
    world.plugin.transactions.map((transaction) => transaction.transactionId),
    [foreignId],
    "StoreKit stops redelivering both; another guest's refunded consumable is left alone",
  );
  assertEqual(
    world.verified,
    [grantedId, refusedId, refusedId],
    'nothing is verified after the answers',
  );
  await second.stop();

  const third = world.run();
  await third.start();
  assertEqual(world.finishCalls().length, 3, 'a later launch has nothing left to finish');
  await third.stop();

  // A native build from before the revoked finish refuses it: the transaction
  // stays unfinished, the refusal is reported, and the record stays terminal.
  const older = setup('ignored');
  older.setBackendUp(false);
  const before = older.run();
  await before.start();
  await before.stop();
  older.plugin.upsert(
    fakeTransaction({ transactionId: refusedId, unfinished: true, revokedAt: refunded }),
  );
  older.setBackendUp(true);
  const once = older.run();
  await once.start();
  assertEqual((await once.read(refusedKey))?.state, 'rejected', 'the backend refused it');
  assertEqual(
    older.plugin.transactions.some((transaction) => transaction.transactionId === refusedId),
    true,
    'an older native build leaves it unfinished',
  );
  assertEqual(older.failures.includes(`finish:${refusedKey}`), true, 'and the refusal is reported');
  await once.stop();
}

console.info('StoreKit commerce reconciler smoke passed.');
