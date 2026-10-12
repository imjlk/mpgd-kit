import { describe, expect, it } from 'vitest';

import {
  createCommerceReconciler,
  createInMemoryMonetizationOperationStore,
  type CommerceReconcilerEvent,
} from '@mpgd/game-services';
import type { PurchaseVerificationApi } from '@mpgd/game-services/client';
import type { VerifyPurchaseRequest } from '@mpgd/game-services/types';
import { createGooglePlayTokenPurchaseKey } from '@mpgd/platform/commerce';

import {
  createFakePlayBillingPlugin,
  fakePlayProduct,
  fakePlayPurchase,
  type FakePlayBillingPlugin,
} from '../test/play-billing-plugin-fixture.js';
import { createCapacitorPlayBillingCommerceProvider } from './commerce-provider.js';

/**
 * The commerce reconciler (`createCommerceReconciler` over
 * `createCapacitorPlayBillingCommerceProvider`) resubmits the owned purchases
 * of a fake plugin to a backend answering scripted decisions: a purchased
 * token is verified once under the `play-token-sha256` key ledgers already
 * hold, a pending purchase is never sent, a rejection is terminal, and an
 * outage stays retryable. Play finishes on the server, so the reconciler never
 * finishes on the client.
 */

const token = 'private-play-token';
const accountId = 'player-1';

type Decision =
  | { readonly verified: true; readonly ledgerEntryId: string }
  | { readonly verified: false; readonly disposition: 'rejected' | 'pending' }
  | { readonly throws: true };

function createPlugin(state: 'purchased' | 'pending'): FakePlayBillingPlugin {
  const plugin = createFakePlayBillingPlugin({
    products: [fakePlayProduct({ productId: 'coins_100' })],
  });
  plugin.upsert(
    fakePlayPurchase({
      products: ['coins_100'],
      purchaseToken: token,
      orderId: 'GPA.1111-2222',
      purchaseState: state,
      obfuscatedAccountId: accountId,
    }),
  );
  return plugin;
}

function answer(decision: Decision, requests: VerifyPurchaseRequest[]): PurchaseVerificationApi {
  return {
    async verifyPurchase(request) {
      requests.push(request);
      if ('throws' in decision) {
        throw new Error('backend unavailable');
      }
      if (!decision.verified) {
        return { verified: false, alreadyProcessed: false, disposition: decision.disposition };
      }
      return {
        verified: true,
        alreadyProcessed: false,
        ledgerEntryId: decision.ledgerEntryId,
        finalization: { status: 'completed', action: 'consume', alreadyCompleted: false },
      };
    },
  };
}

interface Outcome {
  readonly status: 'granted' | 'pending' | 'rejected';
  readonly keys: readonly string[];
}

async function runReconciler(
  decision: Decision,
  state: 'purchased' | 'pending',
): Promise<Outcome & { readonly history: readonly string[] }> {
  const plugin = createPlugin(state);
  const provider = createCapacitorPlayBillingCommerceProvider({
    plugin,
    isAndroid: () => true,
    products: [{ logicalId: 'COINS_100', storeSku: 'coins_100', kind: 'consumable' }],
    accountBinding: () => ({ kind: 'obfuscated-account-id', value: accountId }),
  });
  const requests: VerifyPurchaseRequest[] = [];
  const backend = answer(decision, requests);
  const history: string[] = [];
  const reconciler = createCommerceReconciler({
    provider,
    backend: {
      async verifyPurchase(request) {
        const response = await backend.verifyPurchase(request);
        if (response.verified) {
          // The backend finalizer consumes the purchase after the grant.
          plugin.finalize(token, 'consume');
        }
        return response;
      },
    },
    store: createInMemoryMonetizationOperationStore(),
    playerId: accountId,
    target: 'android',
    onEvent(event: CommerceReconcilerEvent) {
      if (event.type === 'transition') {
        history.push(event.record.state);
      }
    },
  });
  await reconciler.start();
  const [record] = await Promise.all([
    reconciler.read(await createGooglePlayTokenPurchaseKey(token)),
  ]);
  await reconciler.stop();
  const recordState = record?.state;
  return {
    status: recordState === 'finished' || recordState === 'granted' || recordState === 'finishing'
      ? 'granted'
      : recordState === 'rejected'
        ? 'rejected'
        : 'pending',
    keys: requests.map((request) => request.idempotencyKey),
    history,
  };
}

describe('Play Billing commerce reconciler', () => {
  it('verifies a purchased token once under the play-token-sha256 key and grants', async () => {
    const grant: Decision = { verified: true, ledgerEntryId: 'ledger-1' };
    const outcome = await runReconciler(grant, 'purchased');
    const expectedKey = await createGooglePlayTokenPurchaseKey(token);
    expect({ status: outcome.status, keys: outcome.keys })
      .toEqual({ status: 'granted', keys: [expectedKey] });
    expect(outcome.history).toEqual(['purchased', 'verifying', 'granted', 'finishing', 'finished']);
  });

  it('never sends a pending purchase', async () => {
    const grant: Decision = { verified: true, ledgerEntryId: 'ledger-1' };
    const outcome = await runReconciler(grant, 'pending');
    expect({ status: outcome.status, keys: outcome.keys }).toEqual({ status: 'pending', keys: [] });
    expect(outcome.history).toEqual(['pending']);
  });

  it('treats a rejection as terminal', async () => {
    const rejected: Decision = { verified: false, disposition: 'rejected' };
    const outcome = await runReconciler(rejected, 'purchased');
    const expectedKey = await createGooglePlayTokenPurchaseKey(token);
    expect({ status: outcome.status, keys: outcome.keys })
      .toEqual({ status: 'rejected', keys: [expectedKey] });
    expect(outcome.history).toEqual(['purchased', 'verifying', 'rejected']);
  });

  it('keeps a backend outage retryable', async () => {
    const outage: Decision = { throws: true };
    const outcome = await runReconciler(outage, 'purchased');
    const expectedKey = await createGooglePlayTokenPurchaseKey(token);
    expect({ status: outcome.status, keys: outcome.keys })
      .toEqual({ status: 'pending', keys: [expectedKey] });
    expect(outcome.history).toEqual(['purchased', 'verifying']);
  });
});
