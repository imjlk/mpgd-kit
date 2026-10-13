// Shared fixtures for the client-level tests. The file ends in `.test.ts` so
// the package build leaves it out of `dist`; it has no test body of its own.
import {
  createUnsupportedCapabilities,
  type CommerceCapabilities,
  type PlatformGateway,
} from '@mpgd/platform';
import type {
  CommerceProvider,
  RequestPurchaseInput,
  RequestPurchaseResult,
  StorePurchase,
} from '@mpgd/platform/commerce';

export interface TestCommerceProviderOptions {
  readonly store?: string;
  /** `adapter-settled` adds a ledger pointer to every purchase, as a settling provider does. */
  readonly evidence?: CommerceCapabilities['authority']['evidence'];
  /** Who finishes a granted purchase; `none` ends the journal record after the grant. */
  readonly finish?: CommerceCapabilities['lifecycle']['finish'];
  readonly getCapabilities?: () => Promise<CommerceCapabilities>;
  /**
   * The store's answer to a checkout; `calls` counts the checkouts opened so
   * far, this one included. Defaults to a synchronous `purchased` answer.
   */
  readonly answer?: (
    request: RequestPurchaseInput,
    calls: number,
  ) => RequestPurchaseResult | Promise<RequestPurchaseResult>;
}

export interface TestCommerceProvider extends CommerceProvider {
  /** Checkouts opened: each is one store UI. */
  readonly purchaseUiOpened: number;
  readonly requests: readonly RequestPurchaseInput[];
  /** Purchases the store lists as unfinished; push one to model an answer that arrives later. */
  readonly available: StorePurchase[];
}

export function createTestCapabilities(
  options: Pick<TestCommerceProviderOptions, 'evidence' | 'finish'> = {},
): CommerceCapabilities {
  return {
    purchase: { consumable: true, durable: false, subscription: false, quantity: false },
    catalog: { products: true, offers: false, localizedPrice: true },
    lifecycle: {
      availablePurchases: true,
      pending: true,
      restore: false,
      events: true,
      finish: options.finish ?? 'none',
    },
    authority: { evidence: options.evidence ?? 'client-token', accountBinding: 'optional' },
    availability: 'available',
  };
}

/** A store purchase the way a real store reports it: one token per purchase. */
export function createTestStorePurchase(
  request: Pick<RequestPurchaseInput, 'idempotencyKey' | 'logicalId'>,
  overrides: Partial<StorePurchase> = {},
  store = 'test-store',
): StorePurchase {
  return {
    store,
    transactionId: `tx-${request.idempotencyKey}`,
    storeSku: request.logicalId.toLowerCase(),
    logicalId: request.logicalId,
    quantity: 1,
    state: 'purchased',
    token: `token-${request.idempotencyKey}`,
    evidence: {
      schema: 'test.purchase.v1',
      payload: { signedTransaction: 'test-signed-transaction' },
    },
    ...overrides,
  };
}

export function createTestCommerceProvider(
  options: TestCommerceProviderOptions = {},
): TestCommerceProvider {
  const store = options.store ?? 'test-store';
  const requests: RequestPurchaseInput[] = [];
  const available: StorePurchase[] = [];
  let purchaseUiOpened = 0;
  return {
    store,
    requests,
    available,
    get purchaseUiOpened() {
      return purchaseUiOpened;
    },
    getCapabilities: options.getCapabilities ?? (async () => createTestCapabilities(options)),
    async fetchProducts() {
      return [
        {
          logicalId: 'COINS_100',
          store,
          storeSku: 'coins_100',
          kind: 'consumable',
          title: '100 Coins',
          description: 'Adds 100 coins.',
          price: { formatted: '$0.99', currencyCode: 'USD' },
        },
      ];
    },
    async requestPurchase(request) {
      purchaseUiOpened += 1;
      requests.push(request);
      if (options.answer !== undefined) {
        return options.answer(request, purchaseUiOpened);
      }
      return {
        outcome: 'purchased',
        purchase: createTestStorePurchase(
          request,
          options.evidence === 'adapter-settled'
            ? { settlement: { ledgerEntryId: 'settled-ledger' } }
            : {},
          store,
        ),
      };
    },
    async getAvailablePurchases(request = {}) {
      return available.filter(
        (purchase) => request.includePending === true || purchase.state !== 'pending',
      );
    },
    subscribe() {
      return () => {};
    },
  };
}

/**
 * A gateway whose commerce is the given provider, or none: a gateway without
 * a provider sells nothing and its snapshot reports the unsupported block.
 */
export function createTestGateway(
  input: {
    readonly target?: PlatformGateway['target'];
    readonly playerId: string;
    readonly provider?: CommerceProvider;
    readonly ads?: PlatformGateway['ads'];
    readonly leaderboard?: PlatformGateway['leaderboard'];
  },
): PlatformGateway {
  const base = createUnsupportedCapabilities();
  return {
    target: input.target ?? 'android',
    async getCapabilities() {
      return {
        ...base,
        nativeAds: true,
        rewardedAds: true,
        interstitialAds: true,
        nativeLeaderboard: true,
        localizedContent: true,
        ...(input.provider === undefined ? {} : { commerce: await input.provider.getCapabilities() }),
      };
    },
    identity: {
      async getPlayer() {
        return { playerId: input.playerId };
      },
    },
    ...(input.provider === undefined ? {} : { commerce: input.provider }),
    ads: input.ads ?? {
      async preload() {},
      async showRewarded(operation) {
        return {
          status: 'completed',
          rewardGranted: true,
          ledgerEntryId: `impression-${operation.idempotencyKey}`,
          evidence: {
            schema: 'test.reward.v1',
            payload: { signedCallback: 'test-signed-callback' },
          },
        };
      },
    },
    leaderboard: input.leaderboard ?? {
      async submitScore() {
        return { submitted: true };
      },
      async open() {},
    },
    lifecycle: {
      onPause() {
        return () => {};
      },
      onResume() {
        return () => {};
      },
    },
    storage: {
      async load() {
        return null;
      },
      async save() {},
    },
  };
}
