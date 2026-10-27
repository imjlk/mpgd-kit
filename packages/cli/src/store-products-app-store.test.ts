import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  assertProductCatalog,
  assertStoreListingCatalog,
  type StoreListingCatalog,
} from '@mpgd/catalog';

import { createAscIapPort, type AscCommandRunner } from './app-store-iap-asc.js';
import type {
  AscIap,
  AscIapLocalization,
  AscIapPort,
  AscIapVersion,
} from './app-store-iap-port.js';
import { initializeDeployConfig } from './deploy-planning.js';
import { ReleaseProcessError } from './deploy-process.js';
import {
  applyStoreProducts,
  planStoreProducts,
  saveStoreProductPlan,
} from './store-products-command.js';
import {
  applyAppStoreProductPlan,
  AppStoreProductApplyError,
  formatAppStoreProductPlan,
  planAppStoreProducts,
  type AppStoreProductPlan,
} from './store-products-app-store.js';
import { StoreProductPlanStaleError } from './store-products.js';

const appId = '1234567890';
const bundleId = 'dev.mpgd.store';
const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-app-store-products-'));
const shot = path.join(fixture, 'store', 'coins.png');
mkdirSync(path.dirname(shot), { recursive: true });
writeFileSync(shot, Buffer.from('89504e470d0a1a0a-coins', 'utf8'));
const md5 = (file: string): string => createHash('md5').update(readFileSync(file)).digest('hex');

/** Price points App Store Connect offers in the fake, per territory. */
const pricePoints: Record<string, readonly string[]> = {
  USA: ['0.99', '1.99', '2.99', '3.99'],
  KOR: ['1100', '1500', '2200', '4400'],
  JPN: ['160', '300'],
};

interface FakeIap {
  id: string;
  productId: string;
  name: string;
  inAppPurchaseType: string;
  state?: string;
  familySharable?: boolean;
  reviewNote?: string;
  availability?: { territories: string[]; availableInNew: boolean };
}

interface FakeState {
  iaps: FakeIap[];
  versions: Map<string, AscIapVersion[]>;
  localizations: Map<string, AscIapLocalization[]>;
  schedules: Map<string, { baseTerritory: string; manual: Map<string, string>; scheduled?: number }>;
  screenshots: Map<string, { id: string; checksum: string; deliveryState?: string }>;
}

interface FakeAsc {
  readonly port: AscIapPort;
  readonly state: FakeState;
  readonly writes: string[];
  failNext?: { method: string; error: Error } | undefined;
}

/**
 * In-memory App Store Connect: a new in-app purchase starts MISSING_METADATA
 * with one provisioned PREPARE_FOR_SUBMISSION version, and becomes
 * READY_TO_SUBMIT once it has a localization, a price, availability and a
 * review screenshot. A new version copies the latest version's localizations.
 */
function fakeAsc(initial: Partial<FakeState> = {}, options: { provisionVersion?: boolean } = {}): FakeAsc {
  const state: FakeState = {
    iaps: structuredClone(initial.iaps ?? []),
    versions: new Map(initial.versions ?? []),
    localizations: new Map(initial.localizations ?? []),
    schedules: new Map(initial.schedules ?? []),
    screenshots: new Map(initial.screenshots ?? []),
  };
  const writes: string[] = [];
  let counter = 0;
  const fake: FakeAsc = { state, writes, port: undefined as never };
  const write = (method: string, detail: string): void => {
    writes.push(`${method} ${detail}`);
    if (fake.failNext?.method === method) {
      const { error } = fake.failNext;
      fake.failNext = undefined;
      throw error;
    }
  };
  const settle = (iapId: string): void => {
    const iap = state.iaps.find((entry) => entry.id === iapId);
    const version = state.versions.get(iapId)?.[0];
    if (iap?.state === 'MISSING_METADATA' && version !== undefined
      && (state.localizations.get(version.id) ?? []).length > 0 && state.schedules.has(iapId)
      && iap.availability !== undefined && state.screenshots.has(iapId)) {
      iap.state = 'READY_TO_SUBMIT';
    }
  };
  const iap = (id: string): FakeIap => {
    const found = state.iaps.find((entry) => entry.id === id);
    assert.ok(found !== undefined, `iap ${id}`);
    return found;
  };
  const port: AscIapPort = {
    async readAppBundleId(id) {
      assert.equal(id, appId);
      return bundleId;
    },
    async listIaps(id) {
      assert.equal(id, appId);
      return state.iaps.map(({ availability: _availability, ...entry }) => structuredClone(entry));
    },
    async listVersions(iapId) {
      return structuredClone(state.versions.get(iapId) ?? []);
    },
    async listLocalizations(versionId) {
      return structuredClone(state.localizations.get(versionId) ?? []);
    },
    async readPriceSchedule(iapId) {
      const schedule = state.schedules.get(iapId);
      return schedule === undefined
        ? undefined
        : {
            id: `schedule-${iapId}`,
            baseTerritory: schedule.baseTerritory,
            manualPrices: [...schedule.manual].map(([territory, customerPrice]) => ({ territory, customerPrice })),
            scheduledChanges: schedule.scheduled ?? 0,
          };
    },
    async readAvailability(iapId) {
      const availability = iap(iapId).availability;
      return availability === undefined
        ? undefined
        : {
            id: `availability-${iapId}`,
            availableInNewTerritories: availability.availableInNew,
            territories: [...availability.territories],
          };
    },
    async readReviewScreenshot(iapId) {
      const screenshot = state.screenshots.get(iapId);
      return screenshot === undefined
        ? undefined
        : {
            id: screenshot.id,
            sourceFileChecksum: screenshot.checksum,
            ...(screenshot.deliveryState === undefined ? {} : { deliveryState: screenshot.deliveryState }),
          };
    },
    async listTerritories() {
      return ['USA', 'KOR', 'JPN'];
    },
    async createIap(input) {
      write('createIap', input.productId);
      const id = `iap-${++counter}`;
      state.iaps.push({
        id,
        productId: input.productId,
        name: input.referenceName,
        inAppPurchaseType: input.type,
        state: 'MISSING_METADATA',
        ...(input.familySharable ? { familySharable: true } : {}),
      });
      if (options.provisionVersion !== false) {
        state.versions.set(id, [{ id: `${id}-v1`, version: 1, state: 'PREPARE_FOR_SUBMISSION' }]);
      }
      return id;
    },
    async updateIap(input) {
      write('updateIap', `${input.iapId} ${JSON.stringify({ ...input, iapId: undefined })}`);
      const entry = iap(input.iapId);
      if (input.referenceName !== undefined) {
        entry.name = input.referenceName;
      }
      if (input.familySharable === true) {
        entry.familySharable = true;
      }
    },
    async createVersion(iapId) {
      write('createVersion', iapId);
      const versions = state.versions.get(iapId) ?? [];
      const latest = versions[0];
      const number = (latest?.version ?? 0) + 1;
      const id = `${iapId}-v${number}`;
      state.versions.set(iapId, [{ id, version: number, state: 'PREPARE_FOR_SUBMISSION' }, ...versions]);
      // App Store Connect copies the current metadata into the new draft.
      state.localizations.set(id, (latest === undefined ? [] : (state.localizations.get(latest.id) ?? []))
        .map((localization) => ({ ...localization, id: `${localization.id}-copy${number}` })));
      return id;
    },
    async createLocalization(input) {
      write('createLocalization', `${input.versionId} ${input.locale}`);
      const list = state.localizations.get(input.versionId) ?? [];
      list.push({ id: `loc-${++counter}`, locale: input.locale, name: input.name, description: input.description });
      state.localizations.set(input.versionId, list);
      const owner = [...state.versions].find(([, versions]) => versions.some((version) => version.id === input.versionId));
      if (owner !== undefined) {
        settle(owner[0]);
      }
    },
    async updateLocalization(input) {
      write('updateLocalization', input.localizationId);
      for (const list of state.localizations.values()) {
        const found = list.find((localization) => localization.id === input.localizationId);
        if (found !== undefined) {
          Object.assign(found, { name: input.name, description: input.description });
          return;
        }
      }
      assert.fail(`localization ${input.localizationId}`);
    },
    async findPricePoint(input) {
      writes.push(`findPricePoint ${input.territory} ${input.customerPrice}`);
      if (!(pricePoints[input.territory] ?? []).includes(input.customerPrice)) {
        throw new Error(`no price point ${input.customerPrice} in ${input.territory}`);
      }
      return `pp:${input.territory}:${input.customerPrice}`;
    },
    async createPriceSchedule(input) {
      write('createPriceSchedule', `${input.iapId} ${input.baseTerritory} ${input.pricePointIds.join(',')}`);
      state.schedules.set(input.iapId, {
        baseTerritory: input.baseTerritory,
        manual: new Map(input.pricePointIds.map((id) => {
          const [, territory = '', price = ''] = id.split(':');
          return [territory, price];
        })),
      });
      settle(input.iapId);
    },
    async setAvailability(input) {
      write('setAvailability', `${input.iapId} ${input.territories.join(',')} new=${String(input.availableInNewTerritories)}`);
      iap(input.iapId).availability = {
        territories: [...input.territories],
        availableInNew: input.availableInNewTerritories,
      };
      settle(input.iapId);
    },
    async deleteReviewScreenshot(id) {
      write('deleteReviewScreenshot', id);
      for (const [iapId, screenshot] of state.screenshots) {
        if (screenshot.id === id) {
          state.screenshots.delete(iapId);
        }
      }
    },
    async uploadReviewScreenshot(input) {
      write('uploadReviewScreenshot', `${input.iapId} ${path.basename(input.file)}`);
      state.screenshots.set(input.iapId, { id: `shot-${++counter}`, checksum: md5(input.file) });
      settle(input.iapId);
    },
  };
  Object.assign(fake, { port });
  return fake;
}

const catalog = assertProductCatalog({
  version: 'test',
  products: [
    {
      id: 'COINS_100',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 100 },
      platformProductIds: { ios: 'dev.mpgd.store.coins100', android: 'coins_100' },
    },
    {
      id: 'REMOVE_ADS',
      type: 'non_consumable',
      grant: { type: 'entitlement', entitlement: 'remove_ads' },
      platformProductIds: { ios: 'dev.mpgd.store.remove_ads' },
    },
    {
      id: 'COINS_500',
      type: 'consumable',
      grant: { type: 'currency', currency: 'coin', amount: 500 },
      platformProductIds: { ios: 'dev.mpgd.store.coins500' },
    },
    {
      id: 'VIP',
      type: 'subscription',
      grant: { type: 'entitlement', entitlement: 'vip' },
      platformProductIds: { ios: 'dev.mpgd.store.vip' },
    },
  ],
});

const listingsInput = {
  version: 'test',
  products: {
    COINS_100: {
      localizations: { 'en-US': { title: '100 coins', description: 'A small pile of coins.' } },
      appStore: {
        localizations: {
          'en-US': { title: '100 coins', description: 'A small pile of coins.' },
          ko: { title: '코인 100개', description: '코인 한 줌.' },
        },
        price: { baseTerritory: 'USA', customerPrice: '0.99', territories: { KOR: '1500' } },
        reviewNote: 'Open the shop from the title screen.',
        reviewScreenshot: 'store/coins.png',
      },
    },
    REMOVE_ADS: {
      localizations: { 'en-US': { title: 'Remove ads', description: 'No more banners.' } },
      appStore: {
        referenceName: 'Remove ads',
        price: { baseTerritory: 'USA', customerPrice: '2.99' },
        reviewScreenshot: 'store/coins.png',
        familySharable: true,
      },
    },
  },
} as const;
const listings: StoreListingCatalog = assertStoreListingCatalog(listingsInput, catalog);

/** An approved, live REMOVE_ADS with an approved version 1. */
function approvedRemoveAds(): Partial<FakeState> {
  return {
    iaps: [
      {
        id: 'iap-live',
        productId: 'dev.mpgd.store.remove_ads',
        name: 'Remove ads',
        inAppPurchaseType: 'NON_CONSUMABLE',
        state: 'APPROVED',
        familySharable: true,
        availability: { territories: ['USA'], availableInNew: true },
      },
      {
        id: 'iap-old',
        productId: 'dev.mpgd.store.legacy_pack',
        name: 'Legacy pack',
        inAppPurchaseType: 'CONSUMABLE',
        state: 'APPROVED',
      },
    ],
    versions: new Map([['iap-live', [{ id: 'iap-live-v1', version: 1, state: 'APPROVED' }]]]),
    localizations: new Map([
      [
        'iap-live-v1',
        [
          {
            id: 'loc-live-en',
            locale: 'en-US',
            name: 'Remove ads',
            description: 'No more banners.',
          },
          { id: 'loc-live-de', locale: 'de-DE', name: 'Werbung weg', description: 'Keine Banner.' },
        ],
      ],
    ]),
    schedules: new Map([['iap-live', { baseTerritory: 'USA', manual: new Map([['USA', '2.99']]) }]]),
    screenshots: new Map([['iap-live', { id: 'shot-live', checksum: md5(shot) }]]),
  };
}

const planInput = { appId, bundleId, catalog, listings, listingsDirectory: fixture };

function find(plan: AppStoreProductPlan, productId: string) {
  const product = plan.products.find((entry) => entry.productId === productId);
  assert.ok(product !== undefined, `${productId} is planned`);
  return product;
}

try {
  // --- plan: create, unchanged, skip, remote-only; nothing is written --------
  {
    const asc = fakeAsc(approvedRemoveAds());
    const plan = await planAppStoreProducts(planInput, asc.port);
    assert.deepEqual(asc.writes, [], 'plan never writes');
    const coins = find(plan, 'dev.mpgd.store.coins100');
    assert.equal(coins.action, 'create');
    assert.deepEqual(coins.changes, [
      'create',
      'localizations',
      'prices',
      'availability',
      'review-screenshot',
    ]);
    assert.deepEqual(coins.write?.create, {
      type: 'CONSUMABLE',
      referenceName: 'COINS_100',
      familySharable: false,
    });
    assert.deepEqual(coins.write?.prices, {
      baseTerritory: 'USA',
      prices: [
        { territory: 'USA', customerPrice: '0.99' },
        { territory: 'KOR', customerPrice: '1500' },
      ],
    });
    assert.deepEqual(coins.write?.availability, {
      territories: ['JPN', 'KOR', 'USA'],
      availableInNewTerritories: true,
    });
    assert.equal(coins.write?.localizations?.version, 'resolve');
    assert.deepEqual(
      coins.write?.localizations?.entries.map((entry) => entry.locale),
      ['en-US', 'ko'],
    );
    assert.equal(find(plan, 'dev.mpgd.store.remove_ads').action, 'unchanged');
    assert.match(find(plan, 'dev.mpgd.store.remove_ads').notes.join(' '), /de-DE/u);
    assert.deepEqual(plan.skipped, [
      { logicalId: 'COINS_500', productId: 'dev.mpgd.store.coins500', reason: 'no store listing' },
      {
        logicalId: 'VIP',
        productId: 'dev.mpgd.store.vip',
        reason: 'subscriptions are outside the sync',
      },
    ]);
    assert.deepEqual(plan.remoteOnly, ['dev.mpgd.store.legacy_pack']);
    assert.ok(plan.manual.some((step) => /review note of dev\.mpgd\.store\.coins100/u.test(step)));
    assert.ok(
      plan.manual.some((step) => /new app version/u.test(step)),
      'submission stays manual',
    );
    const text = formatAppStoreProductPlan(plan);
    assert.match(text, /create\s+dev\.mpgd\.store\.coins100/u);
    assert.match(text, /manual\s+Submit the in-app purchases/u);

    // --- apply writes the plan; a re-plan is unchanged ------------------------
    await assert.rejects(
      applyAppStoreProductPlan({ saved: plan, current: plan, port: asc.port, approved: false }),
      /--approve/u,
    );
    const result = await applyAppStoreProductPlan({
      saved: plan,
      current: plan,
      port: asc.port,
      approved: true,
    });
    assert.deepEqual(asc.writes, [
      'createIap dev.mpgd.store.coins100',
      'createLocalization iap-1-v1 en-US',
      'createLocalization iap-1-v1 ko',
      'findPricePoint USA 0.99',
      'findPricePoint KOR 1500',
      'createPriceSchedule iap-1 USA pp:USA:0.99,pp:KOR:1500',
      'setAvailability iap-1 JPN,KOR,USA new=true',
      'uploadReviewScreenshot iap-1 coins.png',
    ]);
    assert.deepEqual(
      result.products.map((product) => product.status),
      ['created', 'unchanged'],
    );
    assert.equal(asc.state.iaps.find((entry) => entry.id === 'iap-1')?.state, 'READY_TO_SUBMIT');
    const after = await planAppStoreProducts(planInput, asc.port);
    assert.deepEqual(
      after.products.map((product) => product.action),
      ['unchanged', 'unchanged'],
    );
    asc.writes.length = 0;
    await applyAppStoreProductPlan({ saved: plan, current: after, port: asc.port, approved: true });
    assert.deepEqual(asc.writes, [], 're-running a landed plan writes nothing');
  }

  // --- no provisioned version: apply creates one ------------------------------
  {
    const asc = fakeAsc({}, { provisionVersion: false });
    const plan = await planAppStoreProducts(planInput, asc.port);
    await applyAppStoreProductPlan({ saved: plan, current: plan, port: asc.port, approved: true });
    assert.deepEqual(asc.writes.slice(0, 3), [
      'createIap dev.mpgd.store.coins100',
      'createVersion iap-1',
      'createLocalization iap-1-v1 en-US',
    ]);
  }

  // --- an approved version: changed text goes to a new draft version --------
  {
    const changed = assertStoreListingCatalog(
      {
        version: 'test',
        products: {
          REMOVE_ADS: {
            ...listingsInput.products.REMOVE_ADS,
            localizations: { 'en-US': { title: 'Remove ads', description: 'Banners begone.' } },
          },
        },
      },
      catalog,
    );
    const asc = fakeAsc(approvedRemoveAds());
    const plan = await planAppStoreProducts({ ...planInput, listings: changed }, asc.port);
    const removeAds = find(plan, 'dev.mpgd.store.remove_ads');
    assert.deepEqual(removeAds.changes, ['localizations', 'version']);
    assert.equal(removeAds.write?.localizations?.version, 'create');
    assert.match(removeAds.notes.join(' '), /new draft version/u);
    await applyAppStoreProductPlan({ saved: plan, current: plan, port: asc.port, approved: true });
    assert.deepEqual(asc.writes, [
      'createVersion iap-live',
      'updateLocalization loc-live-en-copy2',
    ]);
    assert.equal(
      asc.state.localizations.get('iap-live-v2')?.length,
      2,
      'the new draft keeps de-DE',
    );
    const after = await planAppStoreProducts({ ...planInput, listings: changed }, asc.port);
    assert.equal(
      find(after, 'dev.mpgd.store.remove_ads').action,
      'unchanged',
      'the draft version is edited next time',
    );
  }

  // --- price changes on an approved in-app purchase need confirmation -------
  {
    const cheaper = assertStoreListingCatalog(
      {
        version: 'test',
        products: {
          REMOVE_ADS: {
            ...listingsInput.products.REMOVE_ADS,
            appStore: {
              ...listingsInput.products.REMOVE_ADS.appStore,
              price: { baseTerritory: 'USA', customerPrice: '1.99' },
            },
          },
        },
      },
      catalog,
    );
    const asc = fakeAsc(approvedRemoveAds());
    const plan = await planAppStoreProducts({ ...planInput, listings: cheaper }, asc.port);
    const removeAds = find(plan, 'dev.mpgd.store.remove_ads');
    assert.deepEqual(removeAds.changes, ['prices']);
    assert.equal(removeAds.livePriceChange, true);
    assert.deepEqual(removeAds.priceChanges, [{ territory: 'USA', from: '2.99', to: '1.99' }]);
    assert.match(formatAppStoreProductPlan(plan), /PRICE CHANGE ON APPROVED PRODUCT/u);
    await assert.rejects(
      applyAppStoreProductPlan({ saved: plan, current: plan, port: asc.port, approved: true }),
      /--confirm-price-change/u,
    );
    assert.deepEqual(asc.writes, []);
    await applyAppStoreProductPlan({
      saved: plan,
      current: plan,
      port: asc.port,
      approved: true,
      confirmPriceChange: true,
    });
    assert.deepEqual(asc.writes, [
      'findPricePoint USA 1.99',
      'createPriceSchedule iap-live USA pp:USA:1.99',
    ]);
    const held = await planAppStoreProducts(
      { ...planInput, listings: cheaper, keepLivePrices: true },
      fakeAsc(approvedRemoveAds()).port,
    );
    assert.equal(find(held, 'dev.mpgd.store.remove_ads').action, 'unchanged');
    assert.match(find(held, 'dev.mpgd.store.remove_ads').notes.join(' '), /held/u);
    // 2.990 and 2.99 are the same price.
    const same = fakeAsc({
      ...approvedRemoveAds(),
      schedules: new Map([
        ['iap-live', { baseTerritory: 'USA', manual: new Map([['USA', '2.990']]) }],
      ]),
    });
    assert.equal(
      find(await planAppStoreProducts(planInput, same.port), 'dev.mpgd.store.remove_ads').action,
      'unchanged',
    );
  }

  // --- reference name, Family Sharing and the review screenshot -------------
  {
    const state = approvedRemoveAds();
    const live = state.iaps?.[0];
    assert.ok(live !== undefined);
    live.name = 'Old name';
    delete live.familySharable;
    state.screenshots = new Map([['iap-live', { id: 'shot-old', checksum: '0'.repeat(32) }]]);
    const asc = fakeAsc(state);
    const plan = await planAppStoreProducts(planInput, asc.port);
    const removeAds = find(plan, 'dev.mpgd.store.remove_ads');
    assert.deepEqual(removeAds.changes, ['reference-name', 'family-sharing', 'review-screenshot']);
    assert.match(removeAds.notes.join(' '), /cannot be turned off/u);
    await applyAppStoreProductPlan({ saved: plan, current: plan, port: asc.port, approved: true });
    assert.deepEqual(
      asc.writes.filter((entry) => entry.includes('iap-live') || entry.includes('shot-old')),
      [
        'updateIap iap-live {"referenceName":"Remove ads","familySharable":true}',
        'deleteReviewScreenshot shot-old',
        'uploadReviewScreenshot iap-live coins.png',
      ],
    );
  }

  // --- refusals --------------------------------------------------------------
  {
    const asc = fakeAsc(approvedRemoveAds());
    const plan = await planAppStoreProducts(planInput, asc.port);
    // App Store Connect changed after the plan.
    const changedRemote = structuredClone(asc.state.iaps);
    const live = changedRemote.find((entry) => entry.id === 'iap-live');
    assert.ok(live !== undefined);
    live.name = 'Renamed in App Store Connect';
    const moved = fakeAsc({ ...approvedRemoveAds(), iaps: changedRemote });
    const current = await planAppStoreProducts(planInput, moved.port);
    await assert.rejects(
      applyAppStoreProductPlan({ saved: plan, current, port: moved.port, approved: true }),
      StoreProductPlanStaleError,
    );
    assert.deepEqual(moved.writes, []);
    // The screenshot file changed after the plan.
    writeFileSync(shot, Buffer.from('89504e470d0a1a0a-edited', 'utf8'));
    await assert.rejects(
      applyAppStoreProductPlan({ saved: plan, current: plan, port: asc.port, approved: true }),
      StoreProductPlanStaleError,
    );
    writeFileSync(shot, Buffer.from('89504e470d0a1a0a-coins', 'utf8'));

    // Two editable versions, a type change, a long display name, a bundle mismatch.
    const twoDrafts = fakeAsc({
      ...approvedRemoveAds(),
      versions: new Map([
        [
          'iap-live',
          [
            { id: 'a', version: 2, state: 'PREPARE_FOR_SUBMISSION' },
            { id: 'b', version: 1, state: 'REJECTED' },
          ],
        ],
      ]),
    });
    await assert.rejects(planAppStoreProducts(planInput, twoDrafts.port), /2 editable/u);
    const typed = approvedRemoveAds();
    Object.assign(typed.iaps?.[0] ?? {}, { inAppPurchaseType: 'CONSUMABLE' });
    await assert.rejects(
      planAppStoreProducts(planInput, fakeAsc(typed).port),
      /cannot change the type/u,
    );
    const long = assertStoreListingCatalog(
      {
        version: 'test',
        products: {
          COINS_100: { localizations: { 'en-US': { title: 'x'.repeat(31), description: 'd' } } },
        },
      },
      catalog,
    );
    await assert.rejects(
      planAppStoreProducts({ ...planInput, listings: long }, fakeAsc().port),
      /2-30 characters/u,
    );
    await assert.rejects(
      planAppStoreProducts({ ...planInput, bundleId: 'dev.other' }, fakeAsc().port),
      /bundle ID dev\.mpgd\.store, not dev\.other/u,
    );

    // A price that is no App Store price point fails at apply, naming the stage.
    const odd = assertStoreListingCatalog(
      {
        version: 'test',
        products: {
          COINS_100: {
            ...listingsInput.products.COINS_100,
            appStore: {
              ...listingsInput.products.COINS_100.appStore,
              price: { baseTerritory: 'USA', customerPrice: '1.23' },
            },
          },
        },
      },
      catalog,
    );
    const fresh = fakeAsc();
    const oddPlan = await planAppStoreProducts({ ...planInput, listings: odd }, fresh.port);
    const error = await applyAppStoreProductPlan({ saved: oddPlan, current: oddPlan, port: fresh.port, approved: true })
      .then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof AppStoreProductApplyError);
    assert.equal(error.stage, 'prices');
    assert.match(error.message, /store products plan/u);
    // The next plan sees the created in-app purchase and plans only what is left.
    const next = await planAppStoreProducts({ ...planInput, listings: odd }, fresh.port);
    assert.deepEqual(find(next, 'dev.mpgd.store.coins100').changes, [
      'prices',
      'availability',
      'review-screenshot',
    ]);
  }

  // --- review findings: live versions, availability, schedules, screenshots -
  {
    const cheaper = assertStoreListingCatalog(
      {
        version: 'test',
        products: {
          REMOVE_ADS: {
            ...listingsInput.products.REMOVE_ADS,
            appStore: {
              ...listingsInput.products.REMOVE_ADS.appStore,
              price: { baseTerritory: 'USA', customerPrice: '1.99' },
            },
          },
        },
      },
      catalog,
    );
    // The in-app purchase reads READY_TO_SUBMIT (a new draft is pending) but
    // version 1 was approved: it is on sale, so the price change needs confirmation.
    const drafted = approvedRemoveAds();
    Object.assign(drafted.iaps?.[0] ?? {}, { state: 'READY_TO_SUBMIT' });
    drafted.versions = new Map([['iap-live', [
      { id: 'iap-live-v2', version: 2, state: 'PREPARE_FOR_SUBMISSION' },
      { id: 'iap-live-v1', version: 1, state: 'REPLACED_WITH_NEW_VERSION' },
    ]]]);
    drafted.localizations = new Map([['iap-live-v2', approvedRemoveAds().localizations?.get('iap-live-v1') ?? []]]);
    const draftedPlan = await planAppStoreProducts(
      { ...planInput, listings: cheaper },
      fakeAsc(drafted).port,
    );
    assert.equal(find(draftedPlan, 'dev.mpgd.store.remove_ads').live, true);
    assert.equal(find(draftedPlan, 'dev.mpgd.store.remove_ads').livePriceChange, true);

    // A scheduled future price is never dropped by a new schedule.
    const scheduled = approvedRemoveAds();
    scheduled.schedules = new Map([['iap-live', { baseTerritory: 'USA', manual: new Map([['USA', '2.99']]), scheduled: 1 }]]);
    const scheduledPlan = await planAppStoreProducts(
      { ...planInput, listings: cheaper },
      fakeAsc(scheduled).port,
    );
    assert.equal(find(scheduledPlan, 'dev.mpgd.store.remove_ads').action, 'unchanged');
    assert.match(
      find(scheduledPlan, 'dev.mpgd.store.remove_ads').notes.join(' '),
      /scheduled price change/u,
    );

    // A manual territory price the file does not name reverts to the equalized price.
    const extra = approvedRemoveAds();
    extra.schedules = new Map([['iap-live', { baseTerritory: 'USA', manual: new Map([['USA', '2.99'], ['KOR', '4400']]) }]]);
    const extraPlan = await planAppStoreProducts(planInput, fakeAsc(extra).port);
    assert.deepEqual(find(extraPlan, 'dev.mpgd.store.remove_ads').priceChanges, [
      { territory: 'KOR', from: '4400', to: 'equalized' },
    ]);

    // An in-app purchase that stays MISSING_METADATA converges once its
    // availability is set; the file's availability is applied when it differs.
    const noShot = assertStoreListingCatalog(
      {
        version: 'test',
        products: {
          COINS_100: {
            localizations: listingsInput.products.COINS_100.localizations,
            appStore: { price: { baseTerritory: 'USA', customerPrice: '0.99' } },
          },
        },
      },
      catalog,
    );
    const stuck = fakeAsc();
    const first = await planAppStoreProducts({ ...planInput, listings: noShot }, stuck.port);
    await applyAppStoreProductPlan({
      saved: first,
      current: first,
      port: stuck.port,
      approved: true,
    });
    assert.equal(stuck.state.iaps[0]?.state, 'MISSING_METADATA', 'no review screenshot yet');
    const second = await planAppStoreProducts({ ...planInput, listings: noShot }, stuck.port);
    assert.equal(find(second, 'dev.mpgd.store.coins100').action, 'unchanged');
    const narrowed = assertStoreListingCatalog(
      {
        version: 'test',
        products: {
          COINS_100: {
            ...noShot.products.COINS_100,
            appStore: {
              ...noShot.products.COINS_100?.appStore,
              availability: { territories: ['USA'], availableInNewTerritories: false },
            },
          },
        },
      },
      catalog,
    );
    const third = await planAppStoreProducts({ ...planInput, listings: narrowed }, stuck.port);
    assert.deepEqual(find(third, 'dev.mpgd.store.coins100').changes, ['availability']);
    assert.match(
      find(third, 'dev.mpgd.store.coins100').notes.join(' '),
      /1 territories, new territories off/u,
    );
    const unpricedTerritory = assertStoreListingCatalog(
      {
        version: 'test',
        products: {
          COINS_100: {
            ...narrowed.products.COINS_100,
            appStore: {
              ...narrowed.products.COINS_100?.appStore,
              price: { baseTerritory: 'USA', customerPrice: '0.99', territories: { KOR: '1500' } },
            },
          },
        },
      },
      catalog,
    );
    await assert.rejects(
      planAppStoreProducts({ ...planInput, listings: unpricedTerritory }, stuck.port),
      /KOR are missing from appStore.availability/u,
    );

    // A failed screenshot delivery with the same checksum is replaced.
    const failed = approvedRemoveAds();
    failed.screenshots = new Map([['iap-live', { id: 'shot-failed', checksum: md5(shot), deliveryState: 'FAILED' }]]);
    const failedPlan = await planAppStoreProducts(planInput, fakeAsc(failed).port);
    assert.deepEqual(find(failedPlan, 'dev.mpgd.store.remove_ads').changes, ['review-screenshot']);
    assert.equal(
      find(failedPlan, 'dev.mpgd.store.remove_ads').write?.reviewScreenshot?.replaceId,
      'shot-failed',
    );

    // Text changes while a version is in review wait for App Review.
    const inReview = approvedRemoveAds();
    inReview.versions = new Map([['iap-live', [
      { id: 'iap-live-v2', version: 2, state: 'WAITING_FOR_REVIEW' },
      { id: 'iap-live-v1', version: 1, state: 'APPROVED' },
    ]]]);
    inReview.localizations = new Map([['iap-live-v2', approvedRemoveAds().localizations?.get('iap-live-v1') ?? []]]);
    const changedText = assertStoreListingCatalog(
      {
        version: 'test',
        products: {
          REMOVE_ADS: {
            ...listingsInput.products.REMOVE_ADS,
            localizations: { 'en-US': { title: 'Remove ads', description: 'Banners begone.' } },
          },
        },
      },
      catalog,
    );
    const reviewPlan = await planAppStoreProducts(
      { ...planInput, listings: changedText },
      fakeAsc(inReview).port,
    );
    assert.equal(find(reviewPlan, 'dev.mpgd.store.remove_ads').action, 'unchanged');
    assert.match(
      find(reviewPlan, 'dev.mpgd.store.remove_ads').notes.join(' '),
      /after App Review answers/u,
    );

    // The plan digest names the screenshot by its relative path: another
    // checkout with the same files plans the same write.
    const other = path.join(fixture, 'other-checkout');
    mkdirSync(path.join(other, 'store'), { recursive: true });
    writeFileSync(path.join(other, 'store', 'coins.png'), readFileSync(shot));
    const here = await planAppStoreProducts(planInput, fakeAsc().port);
    const there = await planAppStoreProducts(
      { ...planInput, listingsDirectory: other },
      fakeAsc().port,
    );
    assert.equal(
      find(here, 'dev.mpgd.store.coins100').desiredSha256,
      find(there, 'dev.mpgd.store.coins100').desiredSha256,
    );
    assert.notEqual(
      find(here, 'dev.mpgd.store.coins100').write?.reviewScreenshot?.file,
      find(there, 'dev.mpgd.store.coins100').write?.reviewScreenshot?.file,
    );

    // A screenshot symlink must stay inside the listing directory.
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'mpgd-outside-'));
    const outside = path.join(outsideDir, 'coins.png');
    writeFileSync(outside, 'outside');
    const linked = path.join(fixture, 'linked');
    mkdirSync(path.join(linked, 'store'), { recursive: true });
    symlinkSync(outside, path.join(linked, 'store', 'coins.png'));
    await assert.rejects(
      planAppStoreProducts({ ...planInput, listingsDirectory: linked }, fakeAsc().port),
      /resolves outside/u,
    );
    rmSync(outsideDir, { recursive: true, force: true });
  }

  // --- the asc commands behind the port ----------------------------------------
  {
    const calls: string[][] = [];
    const responses = new Map<string, unknown>([
      ['apps view', { data: { id: appId, type: 'apps', attributes: { bundleId } } }],
      [
        'iap list',
        {
          data: [
            {
              type: 'inAppPurchases',
              id: '6000',
              attributes: {
                name: 'Remove ads',
                productId: 'dev.mpgd.store.remove_ads',
                inAppPurchaseType: 'NON_CONSUMABLE',
                state: 'APPROVED',
                familySharable: true,
              },
            },
          ],
          links: {},
        },
      ],
      [
        'iap versions list',
        {
          data: [
            {
              type: 'inAppPurchaseVersions',
              id: 'v1',
              attributes: { version: 1, state: 'APPROVED' },
            },
          ],
          links: {},
        },
      ],
      [
        'iap versions localizations list',
        {
          data: [
            {
              type: 'inAppPurchaseLocalizations',
              id: 'l1',
              attributes: { name: 'Remove ads', locale: 'en-US', description: 'No banners.' },
            },
          ],
          links: {},
        },
      ],
      [
        'iap pricing schedules view',
        {
          data: {
            type: 'inAppPurchasePriceSchedules',
            id: 's1',
            attributes: {},
            relationships: { baseTerritory: { data: { type: 'territories', id: 'USA' } } },
          },
          links: {},
        },
      ],
      [
        'iap pricing schedules manual-prices (resolved)',
        {
          prices: [
            {
              territory: 'USA',
              priceId: 'p1',
              pricePointId: 'pp1',
              customerPrice: '2.99',
              currency: 'USD',
              manual: true,
            },
            {
              territory: 'KOR',
              priceId: 'p2',
              pricePointId: 'pp2',
              customerPrice: '4400',
              currency: 'KRW',
              manual: false,
            },
          ],
        },
      ],
      [
        'iap pricing price-points list',
        {
          data: [
            {
              type: 'inAppPurchasePricePoints',
              id: 'pp-299',
              attributes: { customerPrice: '2.99', proceeds: '2.54' },
            },
          ],
          links: {},
        },
      ],
      [
        'pricing territories list',
        { data: [{ type: 'territories', id: 'USA', attributes: { currency: 'USD' } }], links: {} },
      ],
      ['iap create', { data: { type: 'inAppPurchases', id: '6001', attributes: {} }, links: {} }],
      [
        'iap pricing schedules manual-prices',
        {
          data: [
            {
              type: 'inAppPurchasePrices',
              id: 'p1',
              attributes: { startDate: '2025-01-01', manual: true },
            },
            {
              type: 'inAppPurchasePrices',
              id: 'p3',
              attributes: { startDate: '2026-12-01', manual: true },
            },
            { type: 'inAppPurchasePrices', id: 'p4', attributes: { manual: true } },
            {
              type: 'inAppPurchasePrices',
              id: 'p5',
              attributes: { startDate: '2026-01-01', endDate: '2027-01-01', manual: true },
            },
          ],
          links: {},
        },
      ],
      [
        'iap pricing availability view',
        {
          data: {
            type: 'inAppPurchaseAvailabilities',
            id: 'av1',
            attributes: { availableInNewTerritories: true },
          },
        },
      ],
      [
        'iap pricing availabilities available-territories',
        {
          data: [
            { type: 'territories', id: 'USA' },
            { type: 'territories', id: 'KOR' },
          ],
          links: {},
        },
      ],
      [
        'iap versions create',
        {
          data: {
            type: 'inAppPurchaseVersions',
            id: 'v9',
            attributes: { state: 'PREPARE_FOR_SUBMISSION' },
          },
          links: {},
        },
      ],
    ]);
    const notFound = new Set(['iap review-screenshots view']);
    const run: AscCommandRunner = async (args) => {
      calls.push([...args]);
      const key = args.filter((arg) => !arg.startsWith('-')).slice(0, 4).join(' ')
        + (args.includes('--resolved') ? ' (resolved)' : '');
      for (const [prefix, response] of responses) {
        if (key.startsWith(prefix)) {
          return structuredClone(response);
        }
      }
      for (const prefix of notFound) {
        if (key.startsWith(prefix)) {
          throw new ReleaseProcessError('exit', 'Error: not found', 4);
        }
      }
      return { data: { type: 'x', id: 'ok', attributes: {} } };
    };
    const port = createAscIapPort(run, () => '2026-10-27');
    assert.equal(await port.readAppBundleId(appId), bundleId);
    assert.deepEqual(await port.listIaps(appId), [
      {
        id: '6000',
        productId: 'dev.mpgd.store.remove_ads',
        name: 'Remove ads',
        inAppPurchaseType: 'NON_CONSUMABLE',
        state: 'APPROVED',
        familySharable: true,
      },
    ]);
    assert.deepEqual(await port.listVersions('6000'), [
      { id: 'v1', version: 1, state: 'APPROVED' },
    ]);
    assert.deepEqual(await port.listLocalizations('v1'), [
      { id: 'l1', locale: 'en-US', name: 'Remove ads', description: 'No banners.' },
    ]);
    assert.deepEqual(
      await port.readPriceSchedule('6000'),
      {
        id: 's1',
        baseTerritory: 'USA',
        manualPrices: [{ territory: 'USA', customerPrice: '2.99' }],
        scheduledChanges: 2,
      },
      'equalized (non-manual) prices are not the schedule; one price starts and one temporary price ends later',
    );
    assert.deepEqual(await port.readAvailability('6000'), {
      id: 'av1',
      availableInNewTerritories: true,
      territories: ['USA', 'KOR'],
    });
    assert.equal(await port.readReviewScreenshot('6000'), undefined, 'asc exit 4 is "none"');
    assert.deepEqual(await port.listTerritories(), ['USA']);
    assert.equal(
      await port.findPricePoint({ iapId: '6000', territory: 'USA', customerPrice: '2.990' }),
      'pp-299',
    );
    await assert.rejects(
      port.findPricePoint({ iapId: '6000', territory: 'USA', customerPrice: '1.99' }),
      /0 price points/u,
    );
    assert.equal(await port.createIap({
      appId,
      type: 'NON_CONSUMABLE',
      referenceName: 'Pack',
      productId: 'dev.mpgd.store.pack',
      familySharable: true,
    }), '6001');
    assert.equal(await port.createVersion('6001'), 'v9');
    await port.updateIap({ iapId: '6001', referenceName: 'Pack 2' });
    await port.createLocalization({
      versionId: 'v9',
      locale: 'en-US',
      name: 'Pack',
      description: 'A pack.',
    });
    await port.updateLocalization({ localizationId: 'l1', name: 'Pack', description: 'A pack.' });
    await port.createPriceSchedule({
      iapId: '6001',
      baseTerritory: 'USA',
      pricePointIds: ['pp-299', 'pp-kor'],
    });
    await port.setAvailability({
      iapId: '6001',
      territories: ['USA', 'KOR'],
      availableInNewTerritories: true,
    });
    await port.deleteReviewScreenshot('shot-1');
    await port.uploadReviewScreenshot({ iapId: '6001', file: shot });
    assert.deepEqual(calls, [
      ['apps', 'view', '--id', appId],
      ['iap', 'list', '--app', appId, '--paginate'],
      ['iap', 'versions', 'list', '--iap-id', '6000', '--paginate'],
      ['iap', 'versions', 'localizations', 'list', '--version-id', 'v1', '--paginate'],
      ['iap', 'pricing', 'schedules', 'view', '--iap-id', '6000', '--include', 'baseTerritory'],
      ['iap', 'pricing', 'schedules', 'manual-prices', '--schedule-id', 's1', '--resolved'],
      ['iap', 'pricing', 'schedules', 'manual-prices', '--schedule-id', 's1', '--paginate'],
      ['iap', 'pricing', 'availability', 'view', '--iap-id', '6000'],
      ['iap', 'pricing', 'availabilities', 'available-territories', '--id', 'av1', '--paginate'],
      ['iap', 'review-screenshots', 'view', '--iap-id', '6000'],
      ['pricing', 'territories', 'list', '--paginate'],
      [
        'iap',
        'pricing',
        'price-points',
        'list',
        '--iap-id',
        '6000',
        '--territory',
        'USA',
        '--price',
        '2.990',
        '--paginate',
      ],
      [
        'iap',
        'pricing',
        'price-points',
        'list',
        '--iap-id',
        '6000',
        '--territory',
        'USA',
        '--price',
        '1.99',
        '--paginate',
      ],
      [
        'iap',
        'create',
        '--app',
        appId,
        '--type',
        'NON_CONSUMABLE',
        '--ref-name',
        'Pack',
        '--product-id',
        'dev.mpgd.store.pack',
        '--family-sharable',
      ],
      ['iap', 'versions', 'create', '--iap-id', '6001'],
      ['iap', 'update', '--id', '6001', '--ref-name', 'Pack 2'],
      [
        'iap',
        'versions',
        'localizations',
        'create',
        '--version-id',
        'v9',
        '--locale',
        'en-US',
        '--name',
        'Pack',
        '--description',
        'A pack.',
      ],
      [
        'iap',
        'versions',
        'localizations',
        'update',
        '--localization-id',
        'l1',
        '--name',
        'Pack',
        '--description',
        'A pack.',
      ],
      [
        'iap',
        'pricing',
        'schedules',
        'create',
        '--iap-id',
        '6001',
        '--base-territory',
        'USA',
        '--prices',
        'pp-299,pp-kor',
      ],
      [
        'iap',
        'pricing',
        'availability',
        'set',
        '--iap-id',
        '6001',
        '--territories',
        'USA,KOR',
        '--available-in-new-territories',
      ],
      ['iap', 'review-screenshots', 'delete', '--screenshot-id', 'shot-1', '--confirm'],
      ['iap', 'review-screenshots', 'create', '--iap-id', '6001', '--file', shot],
    ]);
    // Any other failure is not "none".
    const failing = createAscIapPort(async () => {
      throw new ReleaseProcessError('exit', 'Error: forbidden', 3);
    });
    await assert.rejects(failing.readPriceSchedule('6000'), ReleaseProcessError);
    await assert.rejects(
      createAscIapPort(async () => ({ data: 'nope' })).listIaps(appId),
      /returned no resource list/u,
    );
    // An unset availability (asc 5.5.0 exits non-zero naming it), a schedule
    // answered with no resource, and a failed screenshot delivery.
    const unset = createAscIapPort(async (args) => {
      if (args.includes('availability')) {
        throw new ReleaseProcessError(
          'exit',
          'In-app purchase 6000 has no availability configured yet; create it with: asc iap pricing availability set',
          1,
        );
      }
      if (args.includes('schedules')) {
        return { data: null };
      }
      return {
        data: {
          type: 'inAppPurchaseAppStoreReviewScreenshots',
          id: 'shot-9',
          attributes: {
            sourceFileChecksum: 'abc',
            assetDeliveryState: { state: 'FAILED', errors: [] },
          },
        },
      };
    });
    assert.equal(await unset.readAvailability('6000'), undefined);
    assert.equal(await unset.readPriceSchedule('6000'), undefined);
    // asc prints App Store Connect's `data: null` as an empty resource.
    const empty = createAscIapPort(async () => ({
      data: { type: '', id: '', attributes: {} },
      links: {},
    }));
    assert.equal(await empty.readPriceSchedule('6000'), undefined);
    assert.equal(await empty.readAvailability('6000'), undefined);
    assert.equal(await empty.readReviewScreenshot('6000'), undefined);
    assert.deepEqual(await unset.readReviewScreenshot('6000'), {
      id: 'shot-9',
      sourceFileChecksum: 'abc',
      deliveryState: 'FAILED',
    });
    await assert.rejects(
      createAscIapPort(async () => {
        throw new ReleaseProcessError('exit', 'Error: internal', 1);
      }).readAvailability('6000'),
      ReleaseProcessError,
      'an unrelated failure is not "no availability"',
    );
  }

  // --- the command reads the iOS profile and the asc credential --------------
  {
    const game = path.join(fixture, 'game');
    mkdirSync(path.join(game, 'apps/mobile'), { recursive: true });
    mkdirSync(path.join(game, 'store'), { recursive: true });
    writeFileSync(path.join(game, 'apps/mobile/package.json'), '{"name":"mobile"}\n');
    writeFileSync(path.join(game, 'store', 'coins.png'), readFileSync(shot));
    writeFileSync(path.join(game, 'mpgd.targets.json'), `${JSON.stringify({
      targets: {
        ios: {
          kind: 'capacitor-ios',
          adapter: 'capacitor',
          artifact: 'ipa',
          gameApp: '.',
          shellApp: 'apps/mobile',
          webDir: 'apps/mobile/www',
          metadata: { bundleId },
        },
      },
    }, null, 2)}\n`);
    const configFile = initializeDeployConfig(game);
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
      profiles: { beta: { targets: { ios: Record<string, unknown> } } };
    };
    config.profiles.beta.targets.ios.testGroup = 'group-1';
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(path.join(game, 'mpgd.catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
    writeFileSync(
      path.join(game, 'mpgd.store-listings.json'),
      `${JSON.stringify(listingsInput, null, 2)}\n`,
    );
    const credentialName = String(
      (config.profiles.beta.targets.ios.submissionCredential as { env: string }).env,
    );
    const environment = {
      MPGD_ASC_BINARY: '/opt/asc',
      MPGD_ASC_APP_ID: appId,
      MPGD_ASC_KEY_ID: 'ABCDE12345',
      MPGD_ASC_ISSUER_ID: 'issuer',
      [credentialName]: 'cHJpdmF0ZQ==',
    };
    const asc = fakeAsc(approvedRemoveAds());
    const sessions: { binary: string; closed: boolean }[] = [];
    const ports = {
      appStore: async (credential: { ascBinary: string }) => {
        const session = { binary: credential.ascBinary, closed: false };
        sessions.push(session);
        return {
          port: asc.port,
          close: () => {
            session.closed = true;
          },
        };
      },
    };
    const planned = await planStoreProducts(
      { game, profile: 'beta', store: 'app-store' },
      environment,
      ports,
    );
    assert.equal(planned.plan.store, 'app-store');
    assert.deepEqual(
      sessions,
      [{ binary: '/opt/asc', closed: true }],
      'the asc session is closed after plan',
    );
    const planFile = path.join(fixture, 'app-store-plan.json');
    saveStoreProductPlan(planFile, planned);
    const applied = await applyStoreProducts({ planFile, approved: true }, environment, ports);
    assert.deepEqual(
      applied.products.map((product) => product.status),
      ['created', 'unchanged'],
    );
    assert.ok('manual' in applied && applied.manual.length > 0, 'apply repeats the manual steps');
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1]?.closed, true);
    await assert.rejects(
      planStoreProducts(
        { game, profile: 'beta', store: 'app-store' },
        { MPGD_ASC_BINARY: '/opt/asc' },
        ports,
      ),
      /MPGD_ASC_APP_ID/u,
    );
    // The asc session is closed when the plan fails too.
    const failing = {
      appStore: async (credential: { ascBinary: string }) => {
        const session = { binary: credential.ascBinary, closed: false };
        sessions.push(session);
        return {
          port: { ...asc.port, readAppBundleId: async () => 'dev.other' },
          close: () => {
            session.closed = true;
          },
        };
      },
    };
    await assert.rejects(
      planStoreProducts({ game, profile: 'beta', store: 'app-store' }, environment, failing),
      /bundle ID dev\.other/u,
    );
    assert.equal(sessions.at(-1)?.closed, true);
  }
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.info('App Store Connect store product sync tests passed.');
