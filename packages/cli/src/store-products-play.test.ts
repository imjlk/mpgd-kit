import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertProductCatalog,
  assertStoreListingCatalog,
  type ProductCatalog,
  type StoreListingCatalog,
} from '@mpgd/catalog';

import { initializeDeployConfig } from './deploy-planning.js';
import type {
  PlayConvertedPrices,
  PlayMoney,
  PlayOneTimeProduct,
  PlayProductCatalogPort,
  PlayPurchaseOption,
} from './play-product-port.js';
import {
  applyStoreProducts,
  planStoreProducts,
  saveStoreProductPlan,
} from './store-products-command.js';
import {
  applyPlayProductPlan,
  formatPlayProductPlan,
  planPlayProducts,
  PlayProductApplyError,
  type PlayProductPlan,
} from './store-products-play.js';
import { decimalToUnitsAndNanos, StoreProductPlanStaleError } from './store-products.js';

const packageName = 'dev.mpgd.store';

/** Recorded-shape `convertRegionPrices` answers for a USD base price. */
function conversion(base: PlayMoney): PlayConvertedPrices {
  const cents = Number(base.units ?? '0') * 100 + Math.round((base.nanos ?? 0) / 10_000_000);
  const money = (currencyCode: string, units: number, nanos = 0): PlayMoney => ({
    currencyCode,
    units: String(units),
    nanos,
  });
  return {
    convertedRegionPrices: {
      US: {
        regionCode: 'US',
        price: money('USD', Math.floor(cents / 100), (cents % 100) * 10_000_000),
      },
      KR: {
        regionCode: 'KR',
        price: money('KRW', Math.round(cents * 15)),
        taxAmount: money('KRW', 100),
      },
      JP: { regionCode: 'JP', price: money('JPY', Math.round(cents * 1.6)) },
    },
    convertedOtherRegionsPrice: {
      usdPrice: money('USD', Math.floor(cents / 100), (cents % 100) * 10_000_000),
      eurPrice: money('EUR', Math.floor(cents / 100), (cents % 100) * 10_000_000),
    },
    regionVersion: { version: '2025/03' },
  };
}

interface FakePlay {
  readonly port: PlayProductCatalogPort;
  readonly writes: string[];
  readonly products: Map<string, PlayOneTimeProduct>;
  failNextPatch?: Error | undefined;
  conversionCalls: number;
}

/** In-memory Play: patch creates with `allowMissing`, new options start `DRAFT`. */
function fakePlay(initial: readonly PlayOneTimeProduct[] = []): FakePlay {
  const products = new Map(
    initial.map((product) => [String(product.productId), structuredClone(product)]),
  );
  const writes: string[] = [];
  const fake: FakePlay = {
    writes,
    products,
    conversionCalls: 0,
    port: {
      async listOneTimeProducts(name) {
        assert.equal(name, packageName);
        return [...products.values()].map((product) => structuredClone(product));
      },
      async convertRegionPrices(input) {
        fake.conversionCalls += 1;
        return conversion(input.price);
      },
      async patchOneTimeProduct(input) {
        writes.push(
          `patch ${input.productId} mask=${input.updateMask} create=${String(input.allowMissing)} v=${input.regionsVersion}`,
        );
        if (fake.failNextPatch !== undefined) {
          const error = fake.failNextPatch;
          fake.failNextPatch = undefined;
          throw error;
        }
        const existing = products.get(input.productId);
        if (existing === undefined && !input.allowMissing) {
          throw Object.assign(new Error('Not found'), { code: 404 });
        }
        assert.equal(
          'regionsVersion' in input.product,
          false,
          'output-only regionsVersion is not sent',
        );
        const options = (input.product.purchaseOptions ?? []).map((option): PlayPurchaseOption => {
          assert.equal('state' in option, false, 'output-only state is not sent');
          const before = existing?.purchaseOptions?.find(
            (candidate) => candidate.purchaseOptionId === option.purchaseOptionId,
          );
          return { ...option, state: before?.state ?? 'DRAFT' };
        });
        const stored: PlayOneTimeProduct = {
          ...structuredClone(input.product),
          purchaseOptions: options,
          regionsVersion: { version: input.regionsVersion },
        };
        products.set(input.productId, stored);
        return stored;
      },
      async activatePurchaseOption(input) {
        writes.push(`activate ${input.productId}/${input.purchaseOptionId}`);
        const product = products.get(input.productId);
        assert.ok(product !== undefined);
        products.set(input.productId, {
          ...product,
          purchaseOptions: product.purchaseOptions?.map((option) =>
            option.purchaseOptionId === input.purchaseOptionId
              ? { ...option, state: 'ACTIVE' }
              : option,
          ),
        });
      },
    },
  };
  return fake;
}

const catalog: ProductCatalog = assertProductCatalog({
  version: 'test',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 100 },
      platformProductIds: { android: 'coins_100', ios: 'dev.mpgd.store.coins100' },
    },
    {
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'remove_ads' },
      platformProductIds: { android: 'remove_ads' },
    },
    {
      id: 'COINS_500',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 500 },
      platformProductIds: { android: 'coins_500' },
    },
    {
      id: 'STARTER',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'starter' },
      platformProductIds: { android: 'starter_pack' },
    },
    {
      id: 'VIP',
      type: 'subscription',
      grant: { type: 'entitlement', entitlement: 'vip' },
      platformProductIds: { android: 'vip' },
    },
    {
      id: 'WEB_ONLY',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 1 },
      platformProductIds: { verse8: 'web-only' },
    },
  ],
});

const listingsInput = {
  version: 'test',
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
    },
    REMOVE_ADS: {
      localizations: { 'en-US': { title: 'Remove ads', description: 'No more banners.' } },
      googlePlay: { price: { base: { currency: 'USD', amount: '2.99' } } },
    },
    STARTER: {
      localizations: { 'en-US': { title: 'Starter pack', description: 'A head start.' } },
    },
  },
} as const;
const listings: StoreListingCatalog = assertStoreListingCatalog(listingsInput, catalog);

function convertedOption(id: string, amount: string, state: string, legacy = true): PlayPurchaseOption {
  const converted = conversion({ currencyCode: 'USD', ...decimalToUnitsAndNanos(amount) });
  return {
    purchaseOptionId: id,
    buyOption: { legacyCompatible: legacy },
    regionalPricingAndAvailabilityConfigs: Object.values(converted.convertedRegionPrices ?? {}).map(
      (entry) => ({
        regionCode: entry.regionCode,
        price: entry.price,
        availability: 'AVAILABLE',
      }),
    ),
    newRegionsConfig: {
      usdPrice: converted.convertedOtherRegionsPrice?.usdPrice,
      eurPrice: converted.convertedOtherRegionsPrice?.eurPrice,
      availability: 'AVAILABLE',
    },
    state,
  };
}

const liveRemoveAds: PlayOneTimeProduct = {
  packageName,
  productId: 'remove_ads',
  listings: [
    { languageCode: 'en-US', title: 'Remove ads', description: 'Old text.' },
    { languageCode: 'de-DE', title: 'Werbung entfernen', description: 'Keine Banner.' },
  ],
  purchaseOptions: [convertedOption('legacy-base', '2.99', 'ACTIVE')],
  regionsVersion: { version: '2022/02' },
};

function find(plan: PlayProductPlan, productId: string) {
  const product = plan.products.find((entry) => entry.productId === productId);
  assert.ok(product !== undefined, `${productId} is planned`);
  return product;
}

// --- plan: create, update, skip, remote-only; nothing is written ----------
{
  const play = fakePlay([
    liveRemoveAds,
    { packageName, productId: 'old_bundle', listings: [], purchaseOptions: [] },
  ]);
  const plan = await planPlayProducts({ packageName, catalog, listings }, play.port);
  assert.deepEqual(play.writes, [], 'plan never writes');
  assert.equal(play.conversionCalls, 2, 'one conversion per distinct base price');

  const coins = find(plan, 'coins_100');
  assert.equal(coins.action, 'create');
  assert.deepEqual(coins.changes, ['listings', 'prices', 'purchase-option', 'activate']);
  assert.equal(coins.purchaseOptionId, 'buy');
  assert.equal(coins.remoteSha256, null);
  const created = coins.write?.patch;
  assert.ok(created !== undefined);
  assert.equal(created.allowMissing, true);
  assert.equal(created.regionsVersion, '2025/03');
  const option = created.product.purchaseOptions?.[0];
  assert.deepEqual(option?.buyOption, { legacyCompatible: true, multiQuantityEnabled: true });
  const kr = option?.regionalPricingAndAvailabilityConfigs?.find(
    (config) => config.regionCode === 'KR',
  );
  assert.deepEqual(
    kr,
    {
      regionCode: 'KR',
      price: { currencyCode: 'KRW', units: '1500', nanos: 0 },
      availability: 'AVAILABLE',
    },
    'the file override replaces the converted KR price',
  );
  const us = option?.regionalPricingAndAvailabilityConfigs?.find(
    (config) => config.regionCode === 'US',
  );
  assert.deepEqual(us?.price, { currencyCode: 'USD', units: '0', nanos: 990_000_000 });
  assert.equal(coins.write?.activatePurchaseOptionId, 'buy');

  const removeAds = find(plan, 'remove_ads');
  assert.equal(removeAds.action, 'update');
  assert.deepEqual(removeAds.changes, ['listings'], 'same converted prices are unchanged');
  assert.equal(removeAds.live, true);
  assert.equal(removeAds.livePriceChange, false);
  assert.equal(removeAds.purchaseOptionId, 'legacy-base', 'the only buy option is managed');
  assert.equal(removeAds.write?.patch?.updateMask, 'listings');
  assert.equal(
    removeAds.write?.patch?.regionsVersion,
    '2022/02',
    'a listings-only patch keeps the remote version',
  );
  assert.deepEqual(
    removeAds.write?.patch?.product.listings?.map((listing) => listing.languageCode),
    ['de-DE', 'en-US'],
    'remote-only languages are kept',
  );
  assert.match(removeAds.notes.join(' '), /de-DE/u);

  assert.deepEqual(plan.skipped, [
    { logicalId: 'COINS_500', productId: 'coins_500', reason: 'no store listing' },
    {
      logicalId: 'STARTER',
      productId: 'starter_pack',
      reason: 'needs googlePlay.price to create the product',
    },
    { logicalId: 'VIP', productId: 'vip', reason: 'subscriptions are outside the sync' },
  ]);
  assert.deepEqual(plan.remoteOnly, ['old_bundle'], 'remote-only products are reported');
  const text = formatPlayProductPlan(plan);
  assert.match(text, /create\s+coins_100/u);
  assert.match(text, /only on Play; not in the catalog \(never deleted\)/u);

  // --- apply: approval, writes, idempotent re-run --------------------------
  await assert.rejects(
    applyPlayProductPlan({ saved: plan, current: plan, port: play.port, approved: false }),
    /--approve/u,
  );
  assert.deepEqual(play.writes, []);
  const result = await applyPlayProductPlan({
    saved: plan,
    current: plan,
    port: play.port,
    approved: true,
  });
  assert.deepEqual(play.writes, [
    'patch coins_100 mask=listings,purchaseOptions create=true v=2025/03',
    'activate coins_100/buy',
    'patch remove_ads mask=listings create=false v=2022/02',
  ]);
  assert.deepEqual(result.products, [
    { productId: 'coins_100', status: 'created' },
    { productId: 'remove_ads', status: 'updated' },
  ]);
  assert.equal(
    play.products.get('old_bundle') !== undefined,
    true,
    'remote-only products are not deleted',
  );

  const after = await planPlayProducts({ packageName, catalog, listings }, play.port);
  assert.deepEqual(
    after.products.map((product) => product.action),
    ['unchanged', 'unchanged'],
  );
  play.writes.length = 0;
  // Re-running the old plan after it landed writes nothing.
  const rerun = await applyPlayProductPlan({
    saved: plan,
    current: after,
    port: play.port,
    approved: true,
  });
  assert.deepEqual(play.writes, []);
  assert.deepEqual(
    rerun.products.map((product) => product.status),
    ['unchanged', 'unchanged'],
  );
}

// --- apply refuses a plan the store moved past ------------------------------
{
  const play = fakePlay([liveRemoveAds]);
  const plan = await planPlayProducts({ packageName, catalog, listings }, play.port);
  play.products.set('remove_ads', {
    ...liveRemoveAds,
    listings: [
      { languageCode: 'en-US', title: 'Remove ads', description: 'Edited in Play Console.' },
    ],
  });
  const current = await planPlayProducts({ packageName, catalog, listings }, play.port);
  await assert.rejects(
    applyPlayProductPlan({ saved: plan, current, port: play.port, approved: true }),
    StoreProductPlanStaleError,
  );
  assert.deepEqual(play.writes, [], 'a stale plan writes nothing');
  await assert.rejects(
    applyPlayProductPlan({
      saved: { ...plan, packageName: 'dev.other' },
      current: plan,
      port: play.port,
      approved: true,
    }),
    StoreProductPlanStaleError,
  );
}

// --- price changes on live products need their own confirmation ------------
{
  const cheaper = assertStoreListingCatalog(
    {
      version: 'test',
      products: {
        REMOVE_ADS: {
          localizations: { 'en-US': { title: 'Remove ads', description: 'Old text.' } },
          googlePlay: { price: { base: { currency: 'USD', amount: '1.99' } } },
        },
      },
    },
    catalog,
  );
  const play = fakePlay([{ ...liveRemoveAds, listings: [liveRemoveAds.listings?.[0] ?? {}] }]);
  const plan = await planPlayProducts({ packageName, catalog, listings: cheaper }, play.port);
  const removeAds = find(plan, 'remove_ads');
  assert.deepEqual(removeAds.changes, ['prices']);
  assert.equal(removeAds.livePriceChange, true);
  assert.match(formatPlayProductPlan(plan), /PRICE CHANGE ON LIVE PRODUCT/u);
  await assert.rejects(
    applyPlayProductPlan({ saved: plan, current: plan, port: play.port, approved: true }),
    /--confirm-price-change/u,
  );
  assert.deepEqual(play.writes, []);
  await applyPlayProductPlan({
    saved: plan,
    current: plan,
    port: play.port,
    approved: true,
    confirmPriceChange: true,
  });
  assert.deepEqual(play.writes, ['patch remove_ads mask=purchaseOptions create=false v=2025/03']);

  const held = await planPlayProducts(
    { packageName, catalog, listings: cheaper, keepLivePrices: true },
    fakePlay([{ ...liveRemoveAds, listings: [liveRemoveAds.listings?.[0] ?? {}] }]).port,
  );
  assert.equal(find(held, 'remove_ads').action, 'unchanged', '--keep-live-prices holds the change');
  assert.match(find(held, 'remove_ads').notes.join(' '), /held/u);
}

// --- a DRAFT option is only activated; INACTIVE is reported, not touched ----
{
  const draft: PlayOneTimeProduct = {
    ...liveRemoveAds,
    listings: [liveRemoveAds.listings?.[0] ?? {}],
    purchaseOptions: [convertedOption('legacy-base', '2.99', 'DRAFT')],
  };
  const update = assertStoreListingCatalog(
    {
      version: 'test',
      products: {
        REMOVE_ADS: {
          ...listingsInput.products.REMOVE_ADS,
          localizations: { 'en-US': { title: 'Remove ads', description: 'Old text.' } },
        },
      },
    },
    catalog,
  );
  const play = fakePlay([draft]);
  const plan = await planPlayProducts({ packageName, catalog, listings: update }, play.port);
  assert.deepEqual(find(plan, 'remove_ads').changes, ['activate']);
  assert.equal(find(plan, 'remove_ads').write?.patch, undefined);
  const result = await applyPlayProductPlan({
    saved: plan,
    current: plan,
    port: play.port,
    approved: true,
  });
  assert.deepEqual(play.writes, ['activate remove_ads/legacy-base']);
  assert.deepEqual(result.products, [{ productId: 'remove_ads', status: 'activated' }]);

  const inactive = fakePlay([
    { ...draft, purchaseOptions: [convertedOption('legacy-base', '2.99', 'INACTIVE')] },
  ]);
  const inactivePlan = await planPlayProducts(
    { packageName, catalog, listings: update },
    inactive.port,
  );
  assert.equal(find(inactivePlan, 'remove_ads').action, 'unchanged');
  assert.match(find(inactivePlan, 'remove_ads').notes.join(' '), /INACTIVE.*does not reactivate/u);
}

// --- purchase options the sync must not guess ------------------------------
{
  const two = fakePlay([
    {
      ...liveRemoveAds,
      purchaseOptions: [
        convertedOption('a', '2.99', 'ACTIVE'),
        convertedOption('b', '2.99', 'ACTIVE', false),
      ],
    },
  ]);
  await assert.rejects(
    planPlayProducts({ packageName, catalog, listings }, two.port),
    /2 purchase options.*googlePlay.purchaseOptionId/u,
  );
  const named = assertStoreListingCatalog({
    version: 'test',
    products: {
      REMOVE_ADS: {
        ...listingsInput.products.REMOVE_ADS,
        googlePlay: { ...listingsInput.products.REMOVE_ADS.googlePlay, purchaseOptionId: 'promo' },
      },
    },
  }, catalog);
  const plan = await planPlayProducts({ packageName, catalog, listings: named }, two.port);
  const removeAds = find(plan, 'remove_ads');
  assert.ok(removeAds.changes.includes('purchase-option'));
  const added = removeAds.write?.patch?.product.purchaseOptions?.find(
    (option) => option.purchaseOptionId === 'promo',
  );
  assert.equal(
    added?.buyOption?.legacyCompatible,
    false,
    'only one buy option may be legacy compatible',
  );
  assert.equal(
    removeAds.write?.patch?.product.purchaseOptions?.length,
    3,
    'other options are kept',
  );

  const rent = fakePlay([
    {
      ...liveRemoveAds,
      purchaseOptions: [
        { purchaseOptionId: 'rent', rentOption: { rentalPeriod: 'P7D' }, state: 'ACTIVE' },
      ],
    },
  ]);
  const rentListing = assertStoreListingCatalog(
    {
      version: 'test',
      products: {
        REMOVE_ADS: { ...named.products.REMOVE_ADS, googlePlay: { purchaseOptionId: 'rent' } },
      },
    },
    catalog,
  );
  await assert.rejects(
    planPlayProducts({ packageName, catalog, listings: rentListing }, rent.port),
    /rent option/u,
  );
}

// --- file errors the planner catches before any write ----------------------
{
  const bad = (googlePlay: unknown, localizations: unknown = listingsInput.products.COINS_100.localizations) =>
    assertStoreListingCatalog(
      {
        version: 'test',
        products: { COINS_100: { localizations, googlePlay } },
      },
      catalog,
    );
  const play = fakePlay();
  await assert.rejects(
    planPlayProducts(
      {
        packageName,
        catalog,
        listings: bad({
          price: {
            base: { currency: 'USD', amount: '1' },
            regions: { KR: { currency: 'USD', amount: '1' } },
          },
        }),
      },
      play.port,
    ),
    /KR price must be in KRW/u,
  );
  await assert.rejects(
    planPlayProducts(
      {
        packageName,
        catalog,
        listings: bad({
          price: {
            base: { currency: 'USD', amount: '1' },
            regions: { ZZ: { currency: 'USD', amount: '1' } },
          },
        }),
      },
      play.port,
    ),
    /does not sell in ZZ/u,
  );
  await assert.rejects(
    planPlayProducts(
      {
        packageName,
        catalog,
        listings: bad(
          { price: { base: { currency: 'USD', amount: '1' } } },
          { 'en-US': { title: 'x'.repeat(56), description: 'd' } },
        ),
      },
      play.port,
    ),
    /longer than 55/u,
  );
  const upper = assertProductCatalog({
    ...catalog,
    products: [{ ...catalog.products[0], platformProductIds: { android: 'Coins_100' } }],
  });
  await assert.rejects(
    planPlayProducts(
      {
        packageName,
        catalog: upper,
        listings: bad({ price: { base: { currency: 'USD', amount: '1' } } }),
      },
      play.port,
    ),
    /lowercase/u,
  );
  assert.deepEqual(play.writes, []);
}

// --- a failed write names what landed --------------------------------------
{
  const play = fakePlay([liveRemoveAds]);
  const plan = await planPlayProducts({ packageName, catalog, listings }, play.port);
  play.failNextPatch = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const error = await applyPlayProductPlan({ saved: plan, current: plan, port: play.port, approved: true })
    .then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof PlayProductApplyError);
  assert.equal(error.productId, 'coins_100');
  assert.equal(error.stage, 'patch');
  assert.match(error.message, /store products plan/u);
}

// --- the command reads the game's profile, files and credential ------------
{
  const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-store-products-'));
  try {
    const game = path.join(fixture, 'game');
    mkdirSync(path.join(game, 'apps/mobile'), { recursive: true });
    writeFileSync(path.join(game, 'apps/mobile/package.json'), '{"name":"mobile"}\n');
    writeFileSync(path.join(game, 'mpgd.targets.json'), `${JSON.stringify({
      targets: {
        android: {
          kind: 'capacitor-android',
          adapter: 'capacitor',
          artifact: 'aab',
          gameApp: '.',
          shellApp: 'apps/mobile',
          webDir: 'apps/mobile/www',
          metadata: { packageId: packageName },
        },
      },
    }, null, 2)}\n`);
    initializeDeployConfig(game);
    writeFileSync(path.join(game, 'mpgd.catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
    writeFileSync(
      path.join(game, 'mpgd.store-listings.json'),
      `${JSON.stringify(listingsInput, null, 2)}\n`,
    );
    const serviceAccount = path.join(fixture, 'service-account.json');
    writeFileSync(serviceAccount, '{}\n');
    const environment = { MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT: serviceAccount };
    const play = fakePlay([liveRemoveAds]);
    const ports: string[] = [];
    const factory = async (file: string): Promise<PlayProductCatalogPort> => {
      ports.push(file);
      return play.port;
    };

    await assert.rejects(
      planStoreProducts({ game, profile: 'beta', store: 'google-play' }, {}, factory),
      /MPGD_GOOGLE_PLAY_SERVICE_ACCOUNT/u,
    );
    const planned = await planStoreProducts(
      { game, profile: 'beta', store: 'google-play' },
      environment,
      factory,
    );
    assert.equal(planned.plan.packageName, packageName);
    assert.deepEqual(ports, [serviceAccount]);
    const planFile = path.join(fixture, 'products-plan.json');
    saveStoreProductPlan(planFile, planned);
    assert.throws(() => saveStoreProductPlan(planFile, planned), /EEXIST/u);

    await assert.rejects(
      applyStoreProducts({ planFile, approved: false }, environment, factory),
      /--approve/u,
    );
    // The listing file changed after review: apply refuses.
    writeFileSync(path.join(game, 'mpgd.store-listings.json'), `${JSON.stringify({
      ...listingsInput,
      products: { ...listingsInput.products, REMOVE_ADS: {
        ...listingsInput.products.REMOVE_ADS,
        localizations: { 'en-US': { title: 'Remove ads', description: 'Changed after review.' } },
      } },
    }, null, 2)}\n`);
    await assert.rejects(
      applyStoreProducts({ planFile, approved: true }, environment, factory),
      StoreProductPlanStaleError,
    );
    assert.deepEqual(play.writes, []);
    writeFileSync(
      path.join(game, 'mpgd.store-listings.json'),
      `${JSON.stringify(listingsInput, null, 2)}\n`,
    );
    const applied = await applyStoreProducts({ planFile, approved: true }, environment, factory);
    assert.deepEqual(
      applied.products.map((product) => product.status),
      ['created', 'updated'],
    );
    await assert.rejects(
      planStoreProducts(
        { game, profile: 'beta', store: 'app-store' as never },
        environment,
        factory,
      ),
      /--store/u,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

console.info('Google Play store product sync tests passed.');
