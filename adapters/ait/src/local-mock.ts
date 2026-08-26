/**
 * Browser-only SDK 3 development substitute.
 *
 * Vite aliases the native Apps in Toss module to this file only for explicit
 * local wrapper development. It intentionally exposes no ads, promotions, or
 * commerce: those paths must be verified in the Toss app sandbox/console.
 */

const localStorageValues = new Map<string, string>();

function unsupported(): boolean {
  return false;
}

function noOpSubscription(): () => void {
  return () => {};
}

/**
 * Local browsers have no native safe-area constant. Throwing preserves the
 * wrapper's CSS `env(safe-area-inset-*)` fallback while keeping ESM exports in
 * parity with the SDK surface consumed by the adapter.
 */
export const SafeArea = {
  get(): never {
    throw new Error('SafeArea is unavailable in the Apps in Toss local mock.');
  },
  subscribe(_input: { readonly onEvent: (insets: unknown) => void }): () => void {
    return noOpSubscription();
  },
};

export const Storage = {
  async getItem(key: string): Promise<string | null> {
    return localStorageValues.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    localStorageValues.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    localStorageValues.delete(key);
  },
};

export async function getUserKeyForGame(): Promise<{ readonly type: 'HASH'; readonly hash: string }> {
  return { type: 'HASH', hash: 'ait-local-player' };
}

export async function getTossShareLink(): Promise<string> {
  return globalThis.location?.href ?? 'https://localhost/';
}

export async function share(): Promise<void> {}

export function isMinVersionSupported(): boolean {
  return false;
}

export const grantPromotionRewardForGame = Object.assign(async (): Promise<'ERROR'> => 'ERROR', {
  isSupported: unsupported,
});

export const requestNotificationAgreement = Object.assign(
  (_callbacks: unknown): (() => void) => noOpSubscription(),
  { isSupported: unsupported },
);

export const loadFullScreenAd = Object.assign(
  (_callbacks: unknown): (() => void) => noOpSubscription(),
  { isSupported: unsupported },
);

export const showFullScreenAd = Object.assign(
  (_callbacks: unknown): (() => void) => noOpSubscription(),
  { isSupported: unsupported },
);

export const TossAds = {
  initialize: Object.assign(
    (_options: unknown): void => {},
    { isSupported: unsupported },
  ),
  attachBanner: Object.assign(
    (_adGroupId: string, _target: string | HTMLElement, _options?: unknown) => ({
      destroy(): void {},
    }),
    { isSupported: unsupported },
  ),
  destroy: Object.assign((_slotId: string): void => {}, { isSupported: unsupported }),
  destroyAll: Object.assign((): void => {}, { isSupported: unsupported }),
};

export async function openGameCenterLeaderboard(): Promise<void> {}

export async function submitGameCenterLeaderBoardScore(): Promise<{ readonly statusCode: 'ERROR' }> {
  return { statusCode: 'ERROR' };
}

export const IAP = {
  createOneTimePurchaseOrder: Object.assign(
    (_callbacks: unknown): (() => void) => noOpSubscription(),
    { isSupported: unsupported },
  ),
  getProductItemList: Object.assign(
    async (): Promise<{ readonly products: readonly unknown[] }> => ({ products: [] }),
    { isSupported: unsupported },
  ),
  getPendingOrders: Object.assign(
    async (): Promise<{ readonly orders: readonly unknown[] }> => ({ orders: [] }),
    { isSupported: unsupported },
  ),
  completeProductGrant: Object.assign(async (): Promise<boolean> => false, { isSupported: unsupported }),
};
