import assert from 'node:assert/strict';

import {
  createTestCapabilities,
  createTestCommerceProvider,
  createTestGateway,
  createTestStorePurchase,
  type TestCommerceProvider,
} from './commerce-test-provider.test.js';
import type { PlatformGateway } from '@mpgd/platform';
import type { CommerceEvent, RequestPurchaseResult } from '@mpgd/platform/commerce';

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
    /** This player's store account binding, by player. */
    readonly accountBindings?: Readonly<Record<string, string>>;
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
        ...(input.accountBindings === undefined
          ? {}
          : {
              commerceAccountBinding: () => {
                const value = input.accountBindings?.[playerId];
                return value === undefined ? undefined : { kind: 'obfuscated-account-id' as const, value };
              },
            }),
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
  // The reserved operation is not ended: no platform outcome or result was journaled.
  const reserved = (await journal.listRecoverable(playerA)).find(
    (record) => record.kind === 'rewarded-ad',
  );
  assert.ok(reserved !== undefined, 'the reserved operation stays open');
  assert.equal((reserved as { platform?: unknown }).platform, undefined);
  assert.equal((reserved as { result?: unknown }).result, undefined);
  await runtimeA.dispose();

  // Without a journal the refusal answers `unavailable` too, with no ad.
  const plainShown: string[] = [];
  const plain = createGameServicesRuntime({
    gateway: createTestGateway({
      target: 'android',
      playerId: playerA,
      ads: {
        async preload() {},
        async showRewarded(request) {
          plainShown.push(request.idempotencyKey);
          return { status: 'completed', rewardGranted: true };
        },
      },
    }),
    playerId: playerA,
    authorityMode: 'non-production',
    allowLocalBackend: true,
    localBackend: {
      purchases: { verifyPurchase: () => Promise.reject(new Error('not called')) },
      adRewards: { claimAdReward: () => Promise.reject(new Error('not called')) },
      leaderboard: { recordScore: () => Promise.reject(new Error('not called')) },
    },
  });
  await plain.dispose();
  assert.equal(
    (await plain.client?.claimRewardedAd({ placementId: 'CONTINUE', idempotencyKey: 'ad-2' }))?.status,
    'unavailable',
  );
  assert.deepEqual(plainShown, []);
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

// The same through the reconciler the runtime exposes.
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
          resolve({ outcome: 'purchased', purchase: createTestStorePurchase(request, {}, 'android-store') });
        opened();
      }),
  });
  const harness = createHarness({ provider });
  const runtimeA = harness.create(playerA);
  const reconciler = runtimeA.client?.commerceReconciler;
  const buying = reconciler?.requestPurchase({
    logicalId: 'COINS_100',
    idempotencyKey: 'direct-sheet',
    source: 'shop',
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
  assert.equal(disposed, false, 'dispose waits for the sheet opened through the reconciler');
  sheet.answer?.();
  await buying;
  await disposing;
  assert.equal((await reconciler?.read('direct-sheet'))?.state, 'purchased');
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

// Static authorization headers never stand in for a refused session.
{
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response('{}');
  }) as unknown as typeof fetch;
  try {
    const session: { player: string | undefined } = { player: undefined };
    const runtime = createGameServicesRuntime({
      gateway: createTestGateway({ target: 'android', playerId: playerA }),
      playerId: playerA,
      authorityMode: 'production',
      baseUrl: 'https://services.example.com',
      headers: { authorization: 'Bearer static' },
      sessionPlayerId: () => session.player,
    });
    await assert.rejects(
      runtime.accountDeletion?.deleteAccount() ?? Promise.resolve(),
      (error: unknown) => error instanceof AccountDeletionError && error.code === 'UNAUTHORIZED'
        && !error.requestSent,
    );
    session.player = playerB;
    await assert.rejects(
      runtime.accountDeletion?.deleteAccount() ?? Promise.resolve(),
      (error: unknown) => error instanceof AccountDeletionError && !error.requestSent,
    );
    assert.equal(fetched, 0, 'nothing was sent');
    await runtime.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// After a restart as another player, Google Play still lists the previous
// player's unacknowledged purchases. One bound to another account is left
// alone (no record, no verify), so that player's own runtime recovers it.
{
  const harness = createHarness({ accountBindings: { [playerA]: 'acct-a', [playerB]: 'acct-b' } });
  const bound = (key: string, account: string | undefined, logicalId = 'COINS_100') =>
    createTestStorePurchase(
      { idempotencyKey: key, logicalId },
      account === undefined
        ? {}
        : { accountBinding: { kind: 'obfuscated-account-id', value: account } },
      'android-store',
    );
  harness.provider.available.push(
    bound('of-a', 'acct-a'),
    bound('of-b', 'acct-b'),
    bound('unbound', undefined),
  );
  harness.session.player = playerB;
  const runtimeB = harness.create(playerB);
  const failures: string[] = [];
  runtimeB.client?.commerceReconciler?.subscribe((event) => {
    if (event.type === 'failure' && event.error instanceof Error) {
      failures.push(event.error.message);
    }
  });
  await runtimeB.monetizationRecovery?.reconcile();
  const sentByB = verifies(harness).map((request) =>
    (request.body as { readonly platformTransactionId: string }).platformTransactionId);
  assert.deepEqual(
    sentByB.sort(),
    ['tx-of-b', 'tx-unbound'],
    "A's purchase is never sent with B's session",
  );
  assert.ok(
    failures.some(
      (message) => message.includes('tx-of-a') && message.includes('another store account'),
    ),
  );
  const journaledByB = [
    ...(await recordsOf(harness.store, playerB)),
    ...(await recordsOf(harness.store, playerA)),
  ];
  assert.ok(
    journaledByB.every((record) => record.purchase?.transactionId !== 'tx-of-a'),
    "A's purchase holds no record (its derived key stays free)",
  );
  await runtimeB.dispose();

  // A, later: its purchase is verified with its own session and granted.
  harness.session.player = playerA;
  const sentBefore = harness.sent.length;
  const runtimeA = harness.create(playerA);
  await runtimeA.monetizationRecovery?.reconcile();
  const sentByA = harness.sent.slice(sentBefore).filter(
    (request) => request.endpoint === gameServicesBackendEndpoints.verifyPurchase,
  );
  assert.deepEqual(
    sentByA.map(
      (request) => (request.body as { readonly platformTransactionId: string }).platformTransactionId,
    ),
    ['tx-of-a'],
  );
  assert.equal(sentByA[0]?.headers?.authorization, `Bearer ${playerA}`);
  await runtimeA.dispose();
}

// The player's Restore Purchases still takes a durable bound to another account (restore sharing).
{
  const harness = createHarness({ accountBindings: { [playerB]: 'acct-b' } });
  const runtimeB = createGameServicesRuntime({
    gateway: createTestGateway({ target: 'android', playerId: playerB, provider: harness.provider }),
    playerId: playerB,
    authorityMode: 'non-production',
    allowLocalBackend: true,
    localBackend: {
      purchases: {
        async verifyPurchase(request) {
          harness.sent.push({
            method: 'POST',
            endpoint: gameServicesBackendEndpoints.verifyPurchase,
            body: request,
          });
          return {
            verified: true,
            ledgerEntryId: `ledger-${request.idempotencyKey}`,
            alreadyProcessed: false,
          };
        },
      },
      adRewards: { claimAdReward: () => Promise.reject(new Error('not called')) },
      leaderboard: { recordScore: () => Promise.reject(new Error('not called')) },
    },
    operationStore: harness.store,
    commerceProducts: [
      { logicalId: 'COINS_100', kind: 'consumable', storeSku: 'coins_100' },
      { logicalId: 'REMOVE_ADS', kind: 'durable', storeSku: 'remove_ads' },
    ],
    commerceAccountBinding: () => ({ kind: 'obfuscated-account-id', value: 'acct-b' }),
  });
  harness.provider.available.push(
    createTestStorePurchase(
      { idempotencyKey: 'durable-of-a', logicalId: 'REMOVE_ADS' },
      { accountBinding: { kind: 'obfuscated-account-id', value: 'acct-a' } },
      'android-store',
    ),
    createTestStorePurchase(
      { idempotencyKey: 'coins-of-a', logicalId: 'COINS_100' },
      { accountBinding: { kind: 'obfuscated-account-id', value: 'acct-a' } },
      'android-store',
    ),
  );
  await runtimeB.monetizationRecovery?.reconcile();
  assert.equal(verifies(harness).length, 0, 'recovery sends neither');
  await runtimeB.monetizationRecovery?.restorePurchases();
  const restored = verifies(harness).map((request) => request.body as {
    readonly platformTransactionId: string;
    readonly intent?: string;
  });
  assert.deepEqual(
    restored.map((body) => [body.platformTransactionId, body.intent]),
    [['tx-durable-of-a', 'restore']],
    'only the durable, as a restore; never the consumable',
  );
  await runtimeB.dispose();
}

// A reconciler started before sign-in subscribes at once; its work waits for
// the session, and a store event after sign-in is reconciled.
{
  const listeners: ((event: CommerceEvent) => void)[] = [];
  const base = createTestCommerceProvider({ store: 'android-store' });
  const provider: TestCommerceProvider = Object.assign(
    Object.create(base) as TestCommerceProvider,
    {
      subscribe(listener: (event: CommerceEvent) => void) {
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
    },
  );
  const harness = createHarness({ provider });
  harness.session.player = undefined;
  const runtimeA = harness.create(playerA);
  const reconciler = runtimeA.client?.commerceReconciler;
  await reconciler?.start();
  assert.equal(listeners.length, 1, 'subscribed while signed out');
  assert.equal(reconciler?.started, true);
  assert.equal(harness.sent.length, 0, 'no work while signed out');
  harness.session.player = playerA;
  listeners[0]?.({
    type: 'purchaseUpdated',
    purchase: createTestStorePurchase(
      { idempotencyKey: 'after-sign-in', logicalId: 'COINS_100' },
      {},
      'android-store',
    ),
  });
  await reconciler?.runUntilIdle();
  assert.equal(verifies(harness).length, 1, 'the event after sign-in is reconciled');
  assert.equal(verifies(harness)[0]?.headers?.authorization, `Bearer ${playerA}`);
  await runtimeA.dispose();
  assert.equal(listeners.length, 0, 'dispose unsubscribes');
  await reconciler?.start();
  assert.equal(listeners.length, 0, 'a closed runtime does not subscribe again');
}

// oRPC: a switch while the headers are resolved surfaces the runtime's code,
// not a generic header resolution failure, and nothing is sent.
{
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    return new Response('{}');
  }) as unknown as typeof fetch;
  try {
    const session: { player: string | undefined } = { player: playerA };
    const runtime = createGameServicesRuntime({
      gateway: createTestGateway({
        target: 'android',
        playerId: playerA,
        provider: createTestCommerceProvider({ store: 'android-store' }),
      }),
      playerId: playerA,
      authorityMode: 'production',
      baseUrl: 'https://services.example.com/rpc',
      transport: 'orpc',
      operationStore: createInMemoryMonetizationOperationStore(),
      sessionPlayerId: () => session.player,
      getHeaders: () => {
        session.player = playerB;
        return { authorization: 'Bearer player-b' };
      },
    });
    const errors: unknown[] = [];
    runtime.client?.commerceReconciler?.subscribe((event) => {
      if (event.type === 'failure') {
        errors.push(event.error);
      }
    });
    await runtime.monetizationRecovery?.reconcile();
    assert.equal(fetched, 0, 'nothing was sent');
    assert.ok(
      errors.some((error) => error instanceof GameServicesRuntimeClosedError
        && error.code === gameServicesPlayerChangedCode),
      'the read failed with GAME_SERVICES_PLAYER_CHANGED',
    );
    await runtime.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// A finished consumable the store reports again is not finished again once
// the session switched while the report was matched.
{
  const finishes: string[] = [];
  const base = createTestCommerceProvider({ store: 'android-store', finish: 'client' });
  const provider: TestCommerceProvider = Object.assign(
    Object.create(base) as TestCommerceProvider,
    {
      async finishTransaction(request: { readonly transactionId: string }) {
        finishes.push(request.transactionId);
        return { finished: true };
      },
    },
  );
  const journal = createInMemoryMonetizationOperationStore();
  const hooks: { onFind?: () => void } = {};
  const harness = createHarness({
    provider,
    store: {
      ...journal,
      async findByTransaction(query) {
        hooks.onFind?.();
        return journal.findByTransaction?.(query);
      },
    },
  });
  const purchase = createTestStorePurchase(
    { idempotencyKey: 'again', logicalId: 'COINS_100' },
    {},
    'android-store',
  );
  base.available.push(purchase);
  const first = harness.create(playerA);
  await first.monetizationRecovery?.reconcile();
  assert.deepEqual(finishes, ['tx-again'], 'granted and finished once');
  await first.dispose();
  // A new session for A: the store lists it again; B signs in while it is matched.
  const second = harness.create(playerA);
  hooks.onFind = () => {
    harness.session.player = playerB;
  };
  await second.monetizationRecovery?.reconcile();
  assert.deepEqual(finishes, ['tx-again'], 'not finished again for the closed runtime');
  await second.dispose();
}

console.info('Game services runtime session checks passed.');
