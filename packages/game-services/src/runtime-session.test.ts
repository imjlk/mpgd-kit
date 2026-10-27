import assert from 'node:assert/strict';

import {
  createTestCapabilities,
  createTestCommerceProvider,
  createTestGateway,
  createTestStorePurchase,
  type TestCommerceProvider,
} from './commerce-test-provider.test.js';
import type { PlatformGateway } from '@mpgd/platform';
import type { RequestPurchaseResult } from '@mpgd/platform/commerce';

import { AccountDeletionError } from './account-deletion.js';
import {
  createGameServicesRuntime,
  gameServicesBackendEndpoints,
  gameServicesPlayerChangedCode,
  GameServicesRuntimeClosedError,
  gameServicesRuntimeDisposedCode,
  gameServicesSessionRequiredCode,
  type CommercePurchaseOperationRecord,
  type GameServicesBackendTransportRequest,
  type GameServicesRuntime,
  type MonetizationOperationStore,
} from './index';
import { createInMemoryMonetizationOperationStore } from './monetization-operation-store.js';

// A runtime is bound to one player for its life. When the session names
// another player (an account switch inside one run), the runtime fails
// closed: no request leaves with the new player's credentials for the old
// player's journal, no purchase is journaled under one player and bound to
// another account, and nothing is ended. A backend answers a purchase
// verified with another player's session with a permanent account-mismatch
// rejection, so sending it would freeze a valid purchase as `rejected`.

const playerA = 'player-a';
const playerB = 'player-b';

interface Harness {
  readonly session: { player: string | undefined };
  readonly sent: GameServicesBackendTransportRequest[];
  readonly provider: TestCommerceProvider;
  readonly store: MonetizationOperationStore;
  /** Runs inside the transport before it answers a verify request. */
  onVerify?: ((request: GameServicesBackendTransportRequest) => void) | undefined;
  /** Runs inside the session's header resolver. */
  onHeaders?: (() => void) | undefined;
  create(playerId: string): GameServicesRuntime;
}

function createHarness(
  input: {
    readonly provider?: TestCommerceProvider;
    readonly store?: MonetizationOperationStore;
    readonly ads?: PlatformGateway['ads'];
  } = {},
): Harness {
  const harness: Harness = {
    session: { player: playerA },
    sent: [],
    provider: input.provider ?? createTestCommerceProvider({ store: 'android-store' }),
    store: input.store ?? createInMemoryMonetizationOperationStore(),
    create(playerId) {
      return createGameServicesRuntime({
        gateway: createTestGateway({
          target: 'android',
          playerId,
          provider: harness.provider,
          ...(input.ads === undefined ? {} : { ads: input.ads }),
        }),
        playerId,
        authorityMode: 'production',
        baseUrl: 'https://services.example.com',
        operationStore: harness.store,
        commerceProducts: [{ logicalId: 'COINS_100', kind: 'consumable', storeSku: 'coins_100' }],
        sessionPlayerId: () => harness.session.player,
        getHeaders: () => {
          harness.onHeaders?.();
          return { authorization: `Bearer ${harness.session.player ?? 'none'}` };
        },
        httpTransport: {
          async send(request) {
            harness.sent.push(request);
            if (request.endpoint !== gameServicesBackendEndpoints.verifyPurchase) {
              // No capabilities or ledger-status read on this backend.
              return { status: 404, body: { code: 'not_found' } };
            }
            harness.onVerify?.(request);
            const body = request.body as { readonly idempotencyKey: string };
            return {
              status: 200,
              body: { verified: true, ledgerEntryId: `ledger-${body.idempotencyKey}`, alreadyProcessed: false },
            };
          },
        },
      });
    },
  };
  return harness;
}

const verifies = (harness: Harness) =>
  harness.sent.filter(
    (request) => request.endpoint === gameServicesBackendEndpoints.verifyPurchase,
  );

async function recordsOf(store: MonetizationOperationStore, playerId: string) {
  return (await store.listRecoverable(playerId)).filter(
    (record): record is CommercePurchaseOperationRecord => record.kind === 'commerce-purchase',
  );
}

// A switch to another player in the middle of a recovery pass: the record
// verified before the switch is granted, the next one is never sent with the
// new player's credentials, and it stays open for player A's next runtime.
{
  const harness = createHarness();
  harness.provider.available.push(
    createTestStorePurchase({ idempotencyKey: 'a-1', logicalId: 'COINS_100' }, {}, 'android-store'),
    createTestStorePurchase({ idempotencyKey: 'a-2', logicalId: 'COINS_100' }, {}, 'android-store'),
  );
  const runtimeA = harness.create(playerA);
  harness.onVerify = () => {
    // Player B signs in while A's first verify is on the wire.
    harness.session.player = playerB;
  };
  await runtimeA.monetizationRecovery?.reconcile();

  assert.equal(verifies(harness).length, 1, 'only the verify sent before the switch left');
  for (const request of harness.sent) {
    assert.equal(
      request.headers?.authorization,
      `Bearer ${playerA}`,
      'nothing left with B credentials',
    );
  }
  const open = await recordsOf(harness.store, playerA);
  assert.deepEqual(
    open.map((record) => record.state).sort(),
    ['granted', 'purchased'],
    'the granted purchase waits for its finish, the other for its verify, both under A',
  );
  assert.equal((await recordsOf(harness.store, playerB)).length, 0, 'nothing journaled for B by A');

  // The runtime closed itself: every later operation is refused, retryably,
  // before the backend or the store.
  const uiBefore = harness.provider.purchaseUiOpened;
  assert.deepEqual(
    await runtimeA.client?.purchase({ productId: 'COINS_100', source: 'shop', idempotencyKey: 'a-new' }),
    {
      status: 'failed',
      purchase: {
        status: 'failed',
        entitlementIds: [],
        diagnostic: { code: gameServicesPlayerChangedCode, retryable: true },
      },
    },
  );
  assert.equal(
    harness.provider.purchaseUiOpened,
    uiBefore,
    'no store UI opened for the closed runtime',
  );
  assert.equal(
    (await runtimeA.client?.claimRewardedAd({ placementId: 'CONTINUE', idempotencyKey: 'r-1' }))?.status,
    'unavailable',
  );
  await assert.rejects(
    runtimeA.monetizationRecovery?.restorePurchases() ?? Promise.resolve(),
    (error: unknown) => error instanceof GameServicesRuntimeClosedError
      && error.code === gameServicesPlayerChangedCode && error.retryable,
  );
  assert.deepEqual(await runtimeA.monetizationRecovery?.reconcile(), [], 'recovery runs nothing');
  // Signing back in as A does not reopen it: the host builds a new runtime.
  harness.session.player = playerA;
  assert.equal(
    (await runtimeA.client?.purchase({ productId: 'COINS_100', source: 'shop', idempotencyKey: 'a-new' }))
      ?.purchase.diagnostic?.code,
    gameServicesPlayerChangedCode,
  );
  await runtimeA.dispose();
  assert.equal(runtimeA.client?.commerceReconciler?.started, false, 'the reconciler stopped');
  const sentBeforeResume = harness.sent.length;

  // A runtime for player A, later, resumes the open record with A's session.
  const resumedA = harness.create(playerA);
  harness.onVerify = undefined;
  await resumedA.monetizationRecovery?.reconcile();
  const resent = harness.sent.slice(sentBeforeResume).filter(
    (request) => request.endpoint === gameServicesBackendEndpoints.verifyPurchase,
  );
  assert.equal(resent.length, 1, 'the open record is verified once');
  assert.equal(resent[0]?.headers?.authorization, `Bearer ${playerA}`);
  assert.equal((await recordsOf(harness.store, playerA)).length, 0, 'nothing open for A any more');
  await resumedA.dispose();
}

// A switch while the headers are resolved: the headers may be the new
// player's, so the request is refused after resolution and never sent.
{
  const harness = createHarness();
  harness.provider.available.push(
    createTestStorePurchase({ idempotencyKey: 'h-1', logicalId: 'COINS_100' }, {}, 'android-store'),
  );
  const runtimeA = harness.create(playerA);
  let resolutions = 0;
  harness.onHeaders = () => {
    resolutions += 1;
    // The first resolution is the backend capabilities read at start; the
    // second is the verify of the discovered purchase.
    if (resolutions === 2) {
      harness.session.player = playerB;
    }
  };
  await runtimeA.monetizationRecovery?.reconcile();
  assert.equal(resolutions, 2);
  assert.deepEqual(
    harness.sent.map((request) => request.endpoint),
    [gameServicesBackendEndpoints.getCommerceCapabilities],
    'the verify never left',
  );
  const open = await recordsOf(harness.store, playerA);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.state, 'verifying', 'the record waits with its saved request');
  await runtimeA.dispose();
}

// A switch between the purchase's first check and the store UI: the store
// never opens (no purchase journaled under A and bound to B's account), and
// the reserved attempt stays retryable rather than ended.
{
  // The purchase reads the provider capabilities after its first check.
  const hooks: { onCapabilities?: () => void } = {};
  const provider = createTestCommerceProvider({
    store: 'android-store',
    getCapabilities: async () => {
      hooks.onCapabilities?.();
      return createTestCapabilities();
    },
  });
  const harness = createHarness({ provider });
  const runtimeA = harness.create(playerA);
  await runtimeA.monetizationRecovery?.reconcile();
  hooks.onCapabilities = () => {
    harness.session.player = playerB;
  };
  const result = await runtimeA.client?.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'late-switch',
  });
  assert.equal(provider.purchaseUiOpened, 0, 'the store UI never opened');
  assert.equal(result?.status, 'failed');
  assert.equal(result?.purchase.diagnostic?.retryable, true, 'the refusal is retryable');
  const reconciler = runtimeA.client?.commerceReconciler;
  const attempt = await reconciler?.read('late-switch');
  assert.ok(
    attempt === undefined || (attempt.state === 'requested' && attempt.error?.retryable === true),
    `the attempt is not ended (${attempt?.state})`,
  );
  assert.equal(verifies(harness).length, 0);
  await runtimeA.dispose();
}

// Signed out: refused retryably, and the runtime stays open for the same player.
{
  const harness = createHarness();
  const runtimeA = harness.create(playerA);
  harness.session.player = undefined;
  const refused = await runtimeA.client?.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'signed-out',
  });
  assert.equal(refused?.purchase.diagnostic?.code, gameServicesSessionRequiredCode);
  assert.equal(harness.provider.purchaseUiOpened, 0);
  harness.session.player = playerA;
  const bought = await runtimeA.client?.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'signed-in-again',
  });
  assert.equal(bought?.status, 'granted', 'the same player buys again after signing back in');
  assert.equal(verifies(harness)[0]?.headers?.authorization, `Bearer ${playerA}`);
  await runtimeA.dispose();
}

// dispose(): idempotent, stops the reconciler, refuses everything before any
// request, and leaves the journal for the next runtime.
{
  const harness = createHarness();
  const runtime = harness.create(playerA);
  await runtime.monetizationRecovery?.reconcile();
  assert.equal(runtime.client?.commerceReconciler?.started, true);
  const first = runtime.dispose();
  const second = runtime.dispose();
  await Promise.all([first, second]);
  await runtime.dispose();
  assert.equal(runtime.client?.commerceReconciler?.started, false);
  const sentBefore = harness.sent.length;
  assert.equal(
    (await runtime.client?.purchase({ productId: 'COINS_100', source: 'shop', idempotencyKey: 'd-1' }))
      ?.purchase.diagnostic?.code,
    gameServicesRuntimeDisposedCode,
  );
  await assert.rejects(
    runtime.client?.submitLeaderboardScore({ leaderboardId: 'main', score: 1, runId: 'run-1' } as never)
      ?? Promise.resolve(),
    GameServicesRuntimeClosedError,
  );
  await assert.rejects(
    runtime.client?.commerceReconciler?.restorePurchases() ?? Promise.resolve(),
    (error: unknown) => (error as { storeCode?: string }).storeCode === gameServicesRuntimeDisposedCode,
  );
  await runtime.client?.commerceReconciler?.reconcile();
  assert.equal(harness.sent.length, sentBefore, 'nothing was sent after dispose');
  assert.equal(harness.provider.purchaseUiOpened, 0);
  // A disabled runtime has nothing to close.
  const disabled = createGameServicesRuntime({
    gateway: createTestGateway({ playerId: playerA }),
    playerId: playerA,
    authorityMode: 'production',
  });
  assert.equal(disabled.mode, 'disabled');
  await disabled.dispose();
}

// A rewarded ad queued before the switch is not shown after it.
{
  const shown: string[] = [];
  const journal = createInMemoryMonetizationOperationStore();
  const hooks: { onReserve?: () => void } = {};
  const harness = createHarness({
    store: {
      ...journal,
      async reserve(record) {
        hooks.onReserve?.();
        return journal.reserve(record);
      },
    },
    ads: {
      async preload() {},
      async showRewarded(request) {
        shown.push(request.idempotencyKey);
        return { status: 'completed', rewardGranted: true };
      },
    },
  });
  const runtimeA = harness.create(playerA);
  hooks.onReserve = () => {
    harness.session.player = playerB;
  };
  const reward = await runtimeA.client?.claimRewardedAd({
    placementId: 'CONTINUE',
    idempotencyKey: 'ad-1',
  });
  assert.deepEqual(shown, [], 'no ad was shown for the closed runtime');
  assert.notEqual(reward?.status, 'granted');
  assert.equal(harness.sent.length, 0, 'no claim left');
  await runtimeA.dispose();
}

// A provider that refuses the account binding because the session changed
// during its preparation: the attempt stays retryable, with the runtime's code.
{
  const hooks: { harness?: Harness } = {};
  const provider = createTestCommerceProvider({
    store: 'android-store',
    answer: () => {
      if (hooks.harness !== undefined) {
        hooks.harness.session.player = playerB;
      }
      return {
        outcome: 'failed',
        error: {
          code: 'ACCOUNT_BINDING_REQUIRED',
          retryable: false,
          storeCode: 'PLAY_BILLING_ACCOUNT_LOOKUP_FAILED',
        },
      };
    },
  });
  const harness = createHarness({ provider });
  hooks.harness = harness;
  const runtimeA = harness.create(playerA);
  const result = await runtimeA.client?.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'bind-race',
  });
  assert.equal(result?.purchase.diagnostic?.code, gameServicesPlayerChangedCode);
  assert.equal(result?.purchase.diagnostic?.retryable, true);
  const attempt = await runtimeA.client?.commerceReconciler?.read('bind-race');
  assert.equal(attempt?.state, 'requested', 'the unopened attempt is not ended');
  assert.equal(attempt?.error?.retryable, true);
  await runtimeA.dispose();
}

// dispose() waits for a purchase whose store sheet is open, so its answer is
// journaled under the player before the host restarts.
{
  const sheet: { answer?: () => void } = {};
  let opened: () => void = () => undefined;
  const sheetOpen = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const provider = createTestCommerceProvider({
    store: 'android-store',
    answer: (request) =>
      new Promise<RequestPurchaseResult>((resolve) => {
        sheet.answer = () =>
          resolve({
            outcome: 'purchased',
            purchase: createTestStorePurchase(request, {}, 'android-store'),
          });
        opened();
      }),
  });
  const harness = createHarness({ provider });
  const runtimeA = harness.create(playerA);
  const buying = runtimeA.client?.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'open-sheet',
  });
  await sheetOpen;
  harness.session.player = playerB;
  let disposed = false;
  const disposing = runtimeA.dispose().then(() => {
    disposed = true;
  });
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(disposed, false, 'dispose waits for the open sheet');
  sheet.answer?.();
  await buying;
  await disposing;
  const record = await runtimeA.client?.commerceReconciler?.read('open-sheet');
  assert.equal(record?.state, 'purchased', 'the answer is journaled under A, not verified with B');
  assert.equal(record?.playerId, playerA);
  assert.equal(verifies(harness).length, 0);
}

// A restore the session switch cut short rejects instead of reporting success.
{
  const harness = createHarness();
  harness.provider.available.push(
    createTestStorePurchase({ idempotencyKey: 'r-a', logicalId: 'COINS_100' }, {}, 'android-store'),
  );
  const runtimeA = harness.create(playerA);
  await runtimeA.monetizationRecovery?.reconcile();
  harness.provider.available.push(
    createTestStorePurchase({ idempotencyKey: 'r-b', logicalId: 'COINS_100' }, {}, 'android-store'),
  );
  harness.onVerify = () => {
    harness.session.player = playerB;
  };
  await assert.rejects(
    runtimeA.monetizationRecovery?.restorePurchases() ?? Promise.resolve(),
    GameServicesRuntimeClosedError,
  );
  await runtimeA.dispose();
}

// Account deletion while signed out still reports the missing session.
{
  const harness = createHarness();
  const runtimeA = harness.create(playerA);
  harness.session.player = undefined;
  await assert.rejects(
    runtimeA.accountDeletion?.deleteAccount() ?? Promise.resolve(),
    (error: unknown) => error instanceof AccountDeletionError && error.code === 'UNAUTHORIZED',
  );
  await runtimeA.dispose();
}

console.info('Game services runtime session checks passed.');
