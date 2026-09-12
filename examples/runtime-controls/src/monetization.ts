import type { GameExecutionController } from '@mpgd/game-runtime';
import { createGameActionCoordinator, type GameActionKind } from '@mpgd/game-runtime/actions';
import { createGameUiBridge } from '@mpgd/game-runtime/ui';
import { createGameServicesClient, type GameServicesBackendApi } from '@mpgd/game-services/client';
import type { PlatformGateway, PurchaseResult, RewardedAdResult } from '@mpgd/platform';

type Mode = 'granted' | 'pending' | 'rejected' | 'exception';

/** Deterministic local fixture: never opens an SDK UI or contacts a server. */
export function createMonetizationFixture(execution: GameExecutionController) {
  const calls = { purchase: 0, ad: 0, verify: 0, claim: 0 };
  let mode: Mode = 'granted';
  let serverRelease: (() => void) | undefined;
  const waitForServer = (): Promise<void> => new Promise((resolve) => {
    serverRelease = resolve;
  });
  const gateway = {
    commerce: {
      async purchase(): Promise<PurchaseResult> {
        calls.purchase += 1;
        if (mode === 'pending') {
          return { status: 'pending', entitlementIds: [] };
        }
        return { status: 'completed', transactionId: 'fixture-transaction', entitlementIds: [] };
      },
    },
    ads: {
      async showRewarded(): Promise<RewardedAdResult> {
        calls.ad += 1;
        return { status: 'completed', rewardGranted: true, ledgerEntryId: 'fixture-impression' };
      },
    },
  } as unknown as PlatformGateway;
  const backend: GameServicesBackendApi = {
    purchases: {
      async verifyPurchase() {
        calls.verify += 1;
        const outcome = mode;
        await waitForServer();
        if (outcome === 'exception') {
          throw new Error('Simulated verification exception');
        }
        return { verified: outcome !== 'rejected', alreadyProcessed: false, ledgerEntryId: 'fixture-purchase-ledger' };
      },
    },
    adRewards: {
      async claimAdReward() {
        calls.claim += 1;
        const outcome = mode;
        await waitForServer();
        if (outcome === 'exception') {
          throw new Error('Simulated claim exception');
        }
        return { granted: outcome !== 'rejected', alreadyProcessed: false, ledgerEntryId: 'fixture-ad-ledger' };
      },
    },
    leaderboard: { async recordScore() {
        return { submitted: false, alreadyProcessed: false, rank: 0, ledgerEntryId: 'unused' }; } },
  };
  const client = createGameServicesClient({
    gateway,
    backend,
    target: 'android',
    playerId: 'fixture-player',
    now: () => '2026-09-13T00:00:00.000Z',
  });
  const coordinator = createGameActionCoordinator({ execution, client });
  const purchase = coordinator.createPurchaseController();
  const ad = coordinator.createRewardedAdController();
  const ui = createGameUiBridge<{ screen: number; status: string }, never, string>({
    initialSnapshot: { screen: 1, status: 'idle' },
  });
  let screen = 1;
  let key = 1;
  let scope = ui.createScope();
  let events = 0;
  let ownerResults = 0;
  let lastCompletedOperation = 0;
  let lastError: string | undefined;
  function requireElement<T extends HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (element === null) {
      throw new Error(`Monetization fixture markup is missing ${selector}.`);
    }
    return element;
  }
  const output = requireElement<HTMLOutputElement>('#action-state');
  function views() {
    const ownScreen = screen;
    return {
      purchase: purchase.bindScope(scope, {
        snapshot: (value) => ({ screen: ownScreen, status: value.status === 'running' && value.progress !== undefined ? value.progress.phase : value.status }),
        event: (value) => `purchase:${value.status}`,
      }),
      ad: ad.bindScope(scope, {
        snapshot: (value) => ({ screen: ownScreen, status: value.status === 'running' && value.progress !== undefined ? value.progress.phase : value.status }),
        event: (value) => `ad:${value.status}`,
      }),
    };
  }
  let bound = views();
  ui.onEvent(() => {
    events += 1;
    render();
  });
  ui.subscribeSnapshot(() => render());
  function observeOwner(value: ReturnType<typeof purchase.getSnapshot> | ReturnType<typeof ad.getSnapshot>): void {
    if (value.status !== 'idle' && value.status !== 'running' && value.operationId > lastCompletedOperation) {
      lastCompletedOperation = value.operationId;
      ownerResults += 1;
    }
    render();
  }
  purchase.subscribe(observeOwner);
  ad.subscribe(observeOwner);
  function state() {
    return {
      ...calls,
      screen,
      key,
      mode,
      events,
      ownerResults,
      ui: ui.getSnapshot(),
      purchaseOwner: purchase.getSnapshot(),
      adOwner: ad.getSnapshot(),
      availability: coordinator.getAvailability(),
      serverWaiting: serverRelease !== undefined,
      lastError,
    };
  }
  function render(): void {
    const value = state();
    output.textContent = `Screen ${value.ui.screen}: ${value.ui.status} · owner ${value.purchaseOwner.status}/${value.adOwner.status} · calls ${calls.purchase}/${calls.verify} purchase, ${calls.ad}/${calls.claim} ad · ${value.availability}`;
  }
  function execute(kind: GameActionKind): void {
    const promise = kind === 'purchase'
      ? bound.purchase.execute({
          productId: 'fixture-product',
          source: 'shop',
          idempotencyKey: `purchase-${key}`,
        })
      : bound.ad.execute({ placementId: 'fixture-placement', idempotencyKey: `ad-${key}` });
    // Long-lived owner observes completion separately from screen events.
    void promise.then(
      () => {
        render();
      },
      () => {
        lastError = 'operation-exception-or-scheduling-rejection';
        render();
      },
    );
    render();
  }
  function newScreen(): void {
    scope.dispose();
    screen += 1;
    scope = ui.createScope();
    bound = views();
    scope.setSnapshot({ screen, status: 'idle' });
  }
  const listeners: (() => void)[] = [];
  function button(id: string, handler: () => void): void {
    const element = requireElement<HTMLButtonElement>(`#${id}`);
    element.addEventListener('click', handler);
    listeners.push(() => element.removeEventListener('click', handler));
  }
  button('purchase', () => execute('purchase'));
  button('rewarded-ad', () => execute('rewarded-ad'));
  button('settle', () => {
    const release = serverRelease;
    serverRelease = undefined;
    release?.();
  });
  button('close-action-ui', newScreen);
  button('next-action', () => {
    key += 1;
    render();
  });
  const select = requireElement<HTMLSelectElement>('#action-mode');
  const change = (): void => {
    mode = select.value as Mode;
    render(); };
  select.addEventListener('change', change);
  listeners.push(() => select.removeEventListener('change', change));
  render();
  return {
    state,
    dispose(): void {
      scope.dispose();
      listeners.forEach((remove) => remove());
      coordinator.dispose();
      purchase.dispose();
      ad.dispose();
      ui.destroy();
    },
  };
}
