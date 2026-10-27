import {
  assertProductCatalog,
  assertStoreListingCatalog,
  resolveStoreListingLocalizations,
  type StoreListingCatalog,
} from './index';

const catalog = assertProductCatalog({
  version: 'test',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 100 },
      platformProductIds: { android: 'coins_100', ios: 'com.example.coins100' },
    },
    {
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'remove_ads' },
      platformProductIds: { android: 'remove_ads', ios: 'com.example.remove_ads' },
    },
    {
      id: 'VIP',
      type: 'subscription',
      grant: { type: 'entitlement', entitlement: 'vip' },
      platformProductIds: { android: 'vip' },
    },
  ],
});

const valid = {
  version: '2026-10-27',
  products: {
    COINS_100: {
      localizations: {
        'en-US': { title: '100 coins', description: 'A small pile of coins.' },
        'ko-KR': { title: '코인 100개', description: '코인 한 줌.' },
      },
      googlePlay: {
        price: {
          base: { currency: 'USD', amount: '0.99' },
          regions: { KR: { currency: 'KRW', amount: '1500' } },
        },
        multiQuantity: true,
      },
      appStore: {
        localizations: {
          'en-US': { title: '100 coins', description: 'A small pile of coins.' },
          ko: { title: '코인 100개', description: '코인 한 줌.' },
        },
        price: { baseTerritory: 'USA', customerPrice: '0.99', territories: { KOR: '1500' } },
        reviewNote: 'Buy from the shop scene.',
        reviewScreenshot: 'store/review/coins_100.png',
      },
    },
    REMOVE_ADS: {
      localizations: { 'en-US': { title: 'Remove ads', description: 'No more banners.' } },
      appStore: { familySharable: true },
    },
  },
} satisfies StoreListingCatalog;

const parsed = assertStoreListingCatalog(valid, catalog);
assertSame(parsed.products.COINS_100?.googlePlay?.price?.base.amount, '0.99');
assertSame(
  Object.keys(resolveStoreListingLocalizations(valid.products.COINS_100, 'appStore')),
  ['en-US', 'ko'],
  'the App Store override replaces the shared localizations',
);
assertSame(
  Object.keys(resolveStoreListingLocalizations(valid.products.COINS_100, 'googlePlay')),
  ['en-US', 'ko-KR'],
  'Google Play falls back to the shared localizations',
);
// Without the catalog only the file's own shape is checked.
assertStoreListingCatalog({ version: 'x', products: { UNKNOWN: valid.products.REMOVE_ADS } });

function rejects(input: unknown, pattern: RegExp, withCatalog = true): void {
  try {
    assertStoreListingCatalog(input, withCatalog ? catalog : undefined);
  } catch (error) {
    if (!pattern.test(String(error))) {
      throw new Error(`Expected ${String(pattern)}, received ${String(error)}`);
    }
    return;
  }
  throw new Error(`Expected a rejection matching ${String(pattern)}.`);
}

function withCoins(patch: Record<string, unknown>): unknown {
  return { version: 'x', products: { COINS_100: { ...valid.products.COINS_100, ...patch } } };
}

rejects({ version: 'x', products: { MISSING: valid.products.REMOVE_ADS } }, /names no product/u);
rejects({ version: 'x', products: { VIP: valid.products.REMOVE_ADS } }, /subscription/u);
rejects(
  { version: 'x', products: { COINS_100: { ...valid.products.REMOVE_ADS } } },
  /Family Sharing/u,
);
rejects(withCoins({ localizations: {} }), /at least one language/u);
rejects(withCoins({ localizations: { english: { title: 'a', description: 'b' } } }), /BCP-47/u);
rejects(
  withCoins({
    localizations: {
      'en-US': { title: 'a', description: 'b' },
      'en-us': { title: 'a', description: 'b' },
    },
  }),
  /twice/u,
);
rejects(withCoins({ localizations: { 'en-US': { title: ' a', description: 'b' } } }), /trimmed/u);
rejects(withCoins({ localizations: { 'en-US': { title: '', description: 'b' } } }), /title/u);
rejects(
  withCoins({ googlePlay: { price: { base: { currency: 'usd', amount: '0.99' } } } }),
  /currency/u,
);
rejects(
  withCoins({ googlePlay: { price: { base: { currency: 'USD', amount: '0.990000000001' } } } }),
  /amount/u,
);
rejects(
  withCoins({ googlePlay: { price: { base: { currency: 'USD', amount: '1e3' } } } }),
  /amount/u,
);
rejects(
  withCoins({
    googlePlay: {
      price: {
        base: { currency: 'USD', amount: '1' },
        regions: { KOR: { currency: 'KRW', amount: '1' } },
      },
    },
  }),
  /alpha-2/u,
);
rejects(withCoins({ googlePlay: { purchaseOptionId: 'Buy_Option' } }), /purchaseOptionId/u);
rejects(
  withCoins({
    appStore: { price: { baseTerritory: 'USA', customerPrice: '1', territories: { KR: '1' } } },
  }),
  /alpha-3/u,
);
rejects(
  withCoins({
    appStore: { price: { baseTerritory: 'USA', customerPrice: '1', territories: { USA: '2' } } },
  }),
  /base territory/u,
);
rejects(withCoins({ appStore: { reviewScreenshot: '../outside.png' } }), /relative path/u);
rejects(withCoins({ appStore: { reviewScreenshot: '/abs/shot.png' } }), /relative path/u);
rejects({ version: '', products: {} }, /version/u, false);

console.info('store listing catalog tests passed');

function assertSame(actual: unknown, expected: unknown, message = 'unexpected value'): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}
