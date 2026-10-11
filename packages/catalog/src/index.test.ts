import {
  assertAdPlacements,
  assertProductCatalog,
  assertProductGrant,
  defaultCatalogCurrencies,
  resolveAdPlacementPlatformId,
  resolveCatalogCurrencies,
  resolveProductPlatformId,
  type AdPlacementEntry,
  type ProductCatalogEntry,
  type ProductGrant,
} from './index';

const resourceGrant = Object.freeze({
  type: 'resource',
  resource: 'hint',
  amount: 5,
}) satisfies ProductGrant;

assertProductGrant(resourceGrant);
assertProductGrant({ type: 'currency', currency: 'coin', amount: 100 });
assertProductGrant({ type: 'entitlement', entitlement: 'theme.ember' });
assertThrows(
  () => assertProductGrant({ type: 'resource', resource: 'hint' } as never),
  'resource grants should require an amount',
);
assertThrows(
  () => assertProductGrant({ type: 'resource', resource: 5, amount: 5 } as never),
  'resource grant names should remain strings',
);
assertThrows(
  () => assertProductGrant({ type: 'resource', resource: '', amount: 5 } as never),
  'resource grant names should be non-empty',
);
assertThrows(
  () => assertProductGrant({ type: 'resource', resource: 'hint', amount: 0 } as never),
  'resource grant amounts should be positive',
);
assertThrows(
  () => assertProductGrant({
    type: 'resource',
    resource: 'hint',
    amount: Number.POSITIVE_INFINITY,
  } as never),
  'resource grant amounts should be finite',
);
assertThrows(
  () => assertProductCatalog({
    version: 'test',
    products: [{
      id: 'INVALID_RESOURCE',
      type: 'consumable',
      grant: { type: 'resource', resource: '', amount: 0 },
      platformProductIds: { reddit: 'invalid-resource' },
    }],
  } as never),
  'catalog validation should enforce resource grant constraints',
);
const customTargetProduct = {
  id: 'HINTS_5',
  type: 'consumable',
  grant: resourceGrant,
  platformProductIds: { 'storefront-web': ' hints_5_web ' },
} satisfies ProductCatalogEntry;
const customTargetCatalog = {
  version: 'custom-target',
  products: [customTargetProduct],
};
assertProductCatalog(customTargetCatalog);
assertEqual(
  resolveProductPlatformId(customTargetProduct, 'storefront-web'),
  'hints_5_web',
  'custom product identifiers should resolve by deployment target',
);
assertEqual(
  resolveProductPlatformId(customTargetProduct, 'constructor'),
  undefined,
  'product identifiers must ignore inherited prototype keys',
);
assertThrows(
  () =>
    assertProductCatalog({
      version: 'collision',
      products: [
        customTargetProduct,
        {
          ...customTargetProduct,
          id: 'HINTS_10',
          platformProductIds: { 'storefront-web': 'hints_5_web' },
        },
      ],
    }),
  'catalog validation should reject normalized product identifier collisions',
);

const customTargetPlacement = {
  id: 'CUSTOM_REWARDED',
  type: 'rewarded',
  frequencyCap: { cooldownSeconds: 30 },
  platformPlacementIds: { 'verse8-staging': ' rewarded_staging ' },
} as const satisfies AdPlacementEntry;
assertAdPlacements({ version: 'custom-target', placements: [customTargetPlacement] });
assertThrows(
  () => assertAdPlacements({
    version: 'banner-reward',
    placements: [{
      id: 'INVALID_BANNER_REWARD',
      type: 'banner',
      reward: { type: 'currency', currency: 'coin', amount: 1 },
      frequencyCap: { cooldownSeconds: 0 },
      platformPlacementIds: { ait: 'banner-group' },
    }],
  } as never),
  'banner placements must not carry rewards',
);
assertEqual(
  resolveAdPlacementPlatformId(customTargetPlacement, 'verse8-staging'),
  'rewarded_staging',
  'custom placement identifiers should resolve by deployment target',
);
assertEqual(
  resolveAdPlacementPlatformId(customTargetPlacement, 'verse8'),
  undefined,
  'placement identifiers must not fall back to another deployment target',
);
assertEqual(
  resolveAdPlacementPlatformId(customTargetPlacement, 'constructor'),
  undefined,
  'placement identifiers must ignore inherited prototype keys',
);
assertThrows(
  () =>
    assertAdPlacements({
      version: 'collision',
      placements: [
        customTargetPlacement,
        {
          ...customTargetPlacement,
          id: 'CUSTOM_REWARDED_DUPLICATE',
          platformPlacementIds: { 'verse8-staging': 'rewarded_staging' },
        },
      ],
    }),
  'ad placement validation should reject normalized platform identifier collisions',
);

const sharedPlacements = {
  version: 'shared-format',
  sharedPlatformPlacementTargets: ['verse8-staging'],
  placements: [customTargetPlacement, { ...customTargetPlacement, id: 'ANOTHER_REWARD' }],
};
assertAdPlacements(sharedPlacements);
assertThrows(
  () => assertAdPlacements({ ...sharedPlacements, sharedPlatformPlacementTargets: [] }),
  'sharing requires an explicit target opt-in',
);
assertThrows(
  () =>
    assertAdPlacements({
      ...sharedPlacements,
      placements: [
        customTargetPlacement,
        { ...customTargetPlacement, id: 'INTERSTITIAL', type: 'interstitial' },
      ],
    }),
  'a physical identifier cannot be shared across ad formats',
);
assertThrows(
  () =>
    assertAdPlacements({
      ...sharedPlacements,
      sharedPlatformPlacementTargets: ['verse8-staging', 'verse8-staging'],
    }),
  'sharing target identifiers must be unique',
);
assertThrows(
  () => assertAdPlacements({ ...sharedPlacements, sharedPlatformPlacementTargets: [' '] }),
  'sharing target identifiers must be normalized',
);

// Declared currencies: a catalog may name its own wallet currency, and a
// currency grant must name one of the declared codes (coin and gem by default).
assertEqual(
  [...resolveCatalogCurrencies({})].join(','),
  [...defaultCatalogCurrencies].join(','),
  'an absent currency list defaults to coin and gem',
);
const walletCurrencyProduct = {
  id: 'WALLET_PACK_100',
  type: 'consumable',
  grant: { type: 'currency', currency: 'wallet-credit', amount: 100 },
  platformProductIds: { android: 'wallet_pack_100' },
} satisfies ProductCatalogEntry;
const walletCurrencyCatalog = assertProductCatalog({
  version: 'custom-currency',
  currencies: ['coin', 'wallet-credit'],
  products: [walletCurrencyProduct],
});
assertEqual(
  [...resolveCatalogCurrencies(walletCurrencyCatalog)].join(','),
  'coin,wallet-credit',
  'declared currencies resolve in declaration order',
);
assertProductGrant({ type: 'currency', currency: 'wallet-credit', amount: 5 });
assertThrows(
  () => assertProductGrant({ type: 'currency', currency: '', amount: 5 } as never),
  'currency grant codes must be non-empty',
);
assertThrows(
  () => assertProductCatalog({ version: 'undeclared', products: [walletCurrencyProduct] }),
  'a currency grant must name a declared currency',
);
assertThrows(
  () =>
    assertProductCatalog({
      version: 'default-list',
      currencies: ['gem'],
      products: [
        { ...walletCurrencyProduct, grant: { type: 'currency', currency: 'coin', amount: 1 } },
      ],
    }),
  'declaring a currency list replaces the default list',
);
assertThrows(
  () => assertProductCatalog({ version: 'empty', currencies: [], products: [] }),
  'a declared currency list must not be empty',
);
assertThrows(
  () => assertProductCatalog({ version: 'duplicate', currencies: ['coin', 'coin'], products: [] }),
  'declared currencies must be unique',
);
assertThrows(
  () => assertProductCatalog({ version: 'untrimmed', currencies: [' coin'], products: [] }),
  'declared currencies must be trimmed',
);
assertAdPlacements({
  version: 'custom-currency',
  placements: [
    {
      ...customTargetPlacement,
      reward: { type: 'currency', currency: 'wallet-credit', amount: 3 },
    },
  ],
});

console.log('Catalog product grant validation test passed.');

function assertThrows(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}
