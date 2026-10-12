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
import { createCapacitorPlayBillingProvider, recoverOwnedPlayPurchases } from './provider.js';

/**
 * The deprecated v1 recovery driver (`recoverOwnedPlayPurchases`) and the
 * commerce v2 reconciler (`createCommerceReconciler` over
 * `createCapacitorPlayBillingCommerceProvider`) resubmit the same owned
 * purchases from the same fake plugin to a backend answering the same
 * decisions, and must agree: a purchased token is verified once under the
 * `play-token-sha256` key v1 ledgers already hold, a pending purchase is
 * never sent, a rejection is terminal, and an outage stays retryable. Play
 * finishes on the server, so neither path finishes on the client.
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

async function runLegacy(decision: Decision, state: 'purchased' | 'pending'): Promise<Outcome> {
  const plugin = createPlugin(state);
  const provider = createCapacitorPlayBillingProvider({
    products: [{ id: 'COINS_100', type: 'consumable', storeId: 'coins_100' }],
    getObfuscatedAccountId: () => accountId,
    sdk: plugin,
    isAndroid: () => true,
  });
  const requests: VerifyPurchaseRequest[] = [];
  const recovered = await recoverOwnedPlayPurchases({
    provider,
    playerId: accountId,
    backend: answer(decision, requests),
  });
  const first = recovered[0];
  if (first === undefined) {
    throw new Error('The owned purchase was not recovered.');
  }
  return { status: first.status, keys: requests.map((request) => request.idempotencyKey) };
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

describe('Play Billing v1 recovery driver and commerce v2 reconciler', () => {
  it('verify a purchased token once under the same play-token-sha256 key and grant', async () => {
    const grant: Decision = { verified: true, ledgerEntryId: 'ledger-1' };
    const legacy = await runLegacy(grant, 'purchased');
    const v2 = await runReconciler(grant, 'purchased');
    const expectedKey = await createGooglePlayTokenPurchaseKey(token);
    expect(legacy).toEqual({ status: 'granted', keys: [expectedKey] });
    expect({ status: v2.status, keys: v2.keys }).toEqual(legacy);
    expect(v2.history).toEqual(['purchased', 'verifying', 'granted', 'finishing', 'finished']);
  });

  it('never send a pending purchase', async () => {
    const grant: Decision = { verified: true, ledgerEntryId: 'ledger-1' };
    const legacy = await runLegacy(grant, 'pending');
    const v2 = await runReconciler(grant, 'pending');
    expect(legacy).toEqual({ status: 'pending', keys: [] });
    expect({ status: v2.status, keys: v2.keys }).toEqual(legacy);
    expect(v2.history).toEqual(['pending']);
  });

  it('treat a rejection as terminal', async () => {
    const rejected: Decision = { verified: false, disposition: 'rejected' };
    const legacy = await runLegacy(rejected, 'purchased');
    const v2 = await runReconciler(rejected, 'purchased');
    expect(legacy.status).toBe('rejected');
    expect({ status: v2.status, keys: v2.keys }).toEqual(legacy);
    expect(v2.history).toEqual(['purchased', 'verifying', 'rejected']);
  });

  it('keep a backend outage retryable', async () => {
    const outage: Decision = { throws: true };
    const legacy = await runLegacy(outage, 'purchased');
    const v2 = await runReconciler(outage, 'purchased');
    expect(legacy.status).toBe('pending');
    expect({ status: v2.status, keys: v2.keys }).toEqual(legacy);
    expect(v2.history).toEqual(['purchased', 'verifying']);
  });
});
