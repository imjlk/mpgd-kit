import {
  resolveProductPlatformId,
  resolveStoreListingLocalizations,
  type GooglePlayListing,
  type ProductCatalog,
  type StoreListingCatalog,
  type StoreListingMoney,
} from '@mpgd/catalog';

import type {
  PlayConvertedPrices,
  PlayMoney,
  PlayNewRegionsConfig,
  PlayOneTimeProduct,
  PlayOneTimeProductListing,
  PlayProductCatalogPort,
  PlayPurchaseOption,
  PlayRegionalPricingConfig,
} from './play-product-port.js';
import {
  decimalToUnitsAndNanos,
  stableJson,
  stableSha256,
  StoreProductPlanStaleError,
  type StoreProductAction,
} from './store-products.js';

/**
 * Google Play one-time product sync: compare the game's catalog and store
 * listing file with `monetization.onetimeproducts` and plan the writes.
 *
 * - Products: https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.onetimeproducts
 * - Create or update (`patch` with `allowMissing`): .../monetization.onetimeproducts/patch
 * - Activation: .../monetization.onetimeproducts.purchaseOptions/batchUpdateStates
 * - Price conversion: .../monetization/convertRegionPrices
 *
 * The plan never writes. Products only on Play are reported, never deleted;
 * listing languages, purchase options and regions the file does not name
 * are kept as they are.
 */

export type PlayProductChange =
  | 'listings'
  | 'prices'
  | 'purchase-option'
  | 'multi-quantity'
  | 'tax-category'
  | 'activate';

export interface PlayPriceChange {
  /** ISO region code, or `new-regions` for Play's future-regions USD/EUR prices. */
  readonly region: string;
  readonly from?: string;
  readonly to?: string;
}

export interface PlayProductWrite {
  /** `onetimeproducts.patch`; absent when only an activation is planned. */
  readonly patch?: {
    readonly product: PlayOneTimeProduct;
    readonly updateMask: string;
    readonly allowMissing: boolean;
    readonly regionsVersion: string;
  };
  /** Purchase option to activate after the patch (`DRAFT` or new). */
  readonly activatePurchaseOptionId?: string;
}

export interface PlannedPlayProduct {
  readonly logicalId: string;
  readonly productId: string;
  readonly action: StoreProductAction;
  readonly changes: readonly PlayProductChange[];
  readonly purchaseOptionId?: string;
  /** The managed purchase option is `ACTIVE`: players can buy the product. */
  readonly live: boolean;
  /** A price of a live product changes; apply needs `--confirm-price-change`. */
  readonly livePriceChange: boolean;
  /** Each regional (or new-regions) price or availability that changes. */
  readonly priceChanges: readonly PlayPriceChange[];
  readonly notes: readonly string[];
  /** Digest of the product as Play returned it; `null` when Play has none. */
  readonly remoteSha256: string | null;
  /** Digest of the planned write. */
  readonly desiredSha256: string;
  readonly write?: PlayProductWrite;
}

export interface PlayProductPlan {
  readonly schemaVersion: 1;
  readonly store: 'google-play';
  readonly packageName: string;
  readonly catalogTarget: string;
  readonly keepLivePrices: boolean;
  readonly products: readonly PlannedPlayProduct[];
  /** Catalog products the sync leaves alone, with the reason. */
  readonly skipped: readonly { readonly logicalId: string; readonly productId?: string; readonly reason: string }[];
  /** Product IDs on Play that no catalog product names. Never deleted. */
  readonly remoteOnly: readonly string[];
}

export interface PlayProductPlanInput {
  readonly packageName: string;
  readonly catalog: ProductCatalog;
  readonly listings: StoreListingCatalog;
  /** Catalog `platformProductIds` key of Google Play; defaults to `android`. */
  readonly catalogTarget?: string;
  /** Leave the prices of live products as they are on Play. */
  readonly keepLivePrices?: boolean;
  readonly signal?: AbortSignal;
}

// OneTimeProduct field limits (API reference): title 55, description 200,
// product ID of digits, lowercase letters, `_` and `.`.
const maxTitleLength = 55;
const maxDescriptionLength = 200;
const productIdPattern = /^[a-z0-9][a-z0-9_.]*$/u;
const purchaseOptionIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const defaultPurchaseOptionId = 'buy';
const maxPrintedPriceChanges = 20;

export async function planPlayProducts(
  input: PlayProductPlanInput,
  port: PlayProductCatalogPort,
): Promise<PlayProductPlan> {
  const catalogTarget = input.catalogTarget ?? 'android';
  const keepLivePrices = input.keepLivePrices === true;
  const remote = await port.listOneTimeProducts(input.packageName, input.signal);
  const remoteById = new Map<string, PlayOneTimeProduct>();
  for (const product of remote) {
    if (typeof product.productId === 'string') {
      remoteById.set(product.productId, product);
    }
  }
  const conversions = new Map<string, Promise<PlayConvertedPrices>>();
  const convert = (money: StoreListingMoney, taxCategory: string | undefined): Promise<PlayConvertedPrices> => {
    const key = stableJson({ money, taxCategory });
    let pending = conversions.get(key);
    if (pending === undefined) {
      pending = port.convertRegionPrices({
        packageName: input.packageName,
        price: toPlayMoney(money),
        ...(taxCategory === undefined ? {} : { productTaxCategoryCode: taxCategory }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      conversions.set(key, pending);
    }
    return pending;
  };

  const products: PlannedPlayProduct[] = [];
  const skipped: PlayProductPlan['skipped'][number][] = [];
  const named = new Set<string>();
  for (const product of input.catalog.products) {
    const productId = resolveProductPlatformId(product, catalogTarget);
    if (productId === undefined) {
      continue;
    }
    named.add(productId);
    if (product.type === 'subscription') {
      skipped.push({
        logicalId: product.id,
        productId,
        reason: 'subscriptions are outside the sync',
      });
      continue;
    }
    const entry = input.listings.products[product.id];
    if (entry === undefined) {
      skipped.push({ logicalId: product.id, productId, reason: 'no store listing' });
      continue;
    }
    if (!productIdPattern.test(productId)) {
      throw new Error(
        `Google Play product ID ${productId} (${product.id}) may contain only digits, lowercase letters, "_" and ".".`,
      );
    }
    const remoteProduct = remoteById.get(productId);
    const planned = await planOne({
      packageName: input.packageName,
      logicalId: product.id,
      productId,
      localizations: resolveStoreListingLocalizations(entry, 'googlePlay'),
      googlePlay: entry.googlePlay ?? {},
      remote: remoteProduct,
      keepLivePrices,
      convert,
    });
    if ('skip' in planned) {
      skipped.push({ logicalId: product.id, productId, reason: planned.skip });
    } else {
      products.push(planned);
    }
  }
  const remoteOnly = [...remoteById.keys()].filter((id) => !named.has(id)).sort();
  return {
    schemaVersion: 1,
    store: 'google-play',
    packageName: input.packageName,
    catalogTarget,
    keepLivePrices,
    products,
    skipped,
    remoteOnly,
  };
}

interface PlanOneInput {
  readonly packageName: string;
  readonly logicalId: string;
  readonly productId: string;
  readonly localizations: Readonly<Record<string, { readonly title: string; readonly description: string }>>;
  readonly googlePlay: GooglePlayListing;
  readonly remote: PlayOneTimeProduct | undefined;
  readonly keepLivePrices: boolean;
  readonly convert: (money: StoreListingMoney, taxCategory: string | undefined) => Promise<PlayConvertedPrices>;
}

async function planOne(input: PlanOneInput): Promise<PlannedPlayProduct | { readonly skip: string }> {
  const { productId, remote, googlePlay } = input;
  const label = `Google Play product ${productId} (${input.logicalId})`;
  const notes: string[] = [];

  // Listings: the file's languages replace Play's; other languages stay.
  const desiredListings: PlayOneTimeProductListing[] = Object.entries(input.localizations).map(
    ([languageCode, text]) => {
      if ([...text.title].length > maxTitleLength) {
        throw new Error(
          `${label}: the ${languageCode} title is longer than ${maxTitleLength} characters.`,
        );
      }
      if ([...text.description].length > maxDescriptionLength) {
        throw new Error(
          `${label}: the ${languageCode} description is longer than ${maxDescriptionLength} characters.`,
        );
      }
      return { languageCode, title: text.title, description: text.description };
    },
  );
  const desiredLanguages = new Set(desiredListings.map((listing) => fold(listing.languageCode)));
  const keptListings = (remote?.listings ?? []).filter(
    (listing) => !desiredLanguages.has(fold(listing.languageCode)),
  );
  if (keptListings.length > 0) {
    notes.push(`Play keeps listing languages the file does not name: ${
      keptListings.map((listing) => String(listing.languageCode)).join(', ')}.`);
  }
  const listings = sortListings([...desiredListings, ...keptListings]);

  // The managed purchase option.
  const remoteOptions = remote?.purchaseOptions ?? [];
  let purchaseOptionId = googlePlay.purchaseOptionId;
  if (purchaseOptionId === undefined) {
    const buyOptions = remoteOptions.filter((option) => option.buyOption !== undefined);
    if (remoteOptions.length === 0) {
      purchaseOptionId = defaultPurchaseOptionId;
    } else if (buyOptions.length === 1 && typeof buyOptions[0]?.purchaseOptionId === 'string') {
      purchaseOptionId = buyOptions[0].purchaseOptionId;
    } else {
      throw new Error(
        `${label} has ${remoteOptions.length} purchase options on Play; name the one to manage with `
        + 'googlePlay.purchaseOptionId.',
      );
    }
  }
  if (!purchaseOptionIdPattern.test(purchaseOptionId)) {
    throw new Error(
      `${label}: purchase option ID ${purchaseOptionId} is not a valid Play purchase option ID.`,
    );
  }
  const remoteOption = remoteOptions.find((option) => option.purchaseOptionId === purchaseOptionId);
  if (remoteOption?.rentOption !== undefined && remoteOption.rentOption !== null) {
    throw new Error(
      `${label}: purchase option ${purchaseOptionId} is a rent option; the sync manages buy options only.`,
    );
  }
  if (googlePlay.price === undefined) {
    if (remote === undefined) {
      return { skip: 'needs googlePlay.price to create the product' };
    }
    if (remoteOption === undefined) {
      throw new Error(
        `${label}: purchase option ${purchaseOptionId} is not on Play and the file gives no price for it.`,
      );
    }
  }

  // Prices: Play's conversion of the base price, then the file's overrides.
  let pricing: {
    readonly regional: PlayRegionalPricingConfig[];
    readonly newRegions: PlayNewRegionsConfig | undefined;
    readonly regionsVersion: string;
  } | undefined;
  if (googlePlay.price !== undefined) {
    const converted = await input.convert(googlePlay.price.base, googlePlay.productTaxCategoryCode);
    const regionsVersion = converted.regionVersion?.version;
    if (typeof regionsVersion !== 'string' || regionsVersion === '') {
      throw new Error('Google Play price conversion returned no regions version.');
    }
    const byRegion = new Map<string, PlayRegionalPricingConfig>();
    for (const [key, value] of Object.entries(converted.convertedRegionPrices ?? {})) {
      const regionCode = value.regionCode ?? key;
      if (value.price?.currencyCode === undefined || value.price.currencyCode === null) {
        throw new Error(`Google Play price conversion returned no price for ${regionCode}.`);
      }
      byRegion.set(regionCode, {
        regionCode,
        price: normalizeMoney(value.price),
        availability: 'AVAILABLE',
      });
    }
    for (const [regionCode, money] of Object.entries(googlePlay.price.regions ?? {})) {
      const convertedRegion = byRegion.get(regionCode);
      if (convertedRegion === undefined) {
        throw new Error(
          `${label}: Google Play does not sell in ${regionCode} at regions version ${regionsVersion}.`,
        );
      }
      if (convertedRegion.price?.currencyCode !== money.currency) {
        throw new Error(
          `${label}: the ${regionCode} price must be in ${String(convertedRegion.price?.currencyCode)}, not ${money.currency}.`,
        );
      }
      byRegion.set(regionCode, {
        regionCode,
        price: toPlayMoney(money),
        availability: 'AVAILABLE',
      });
    }
    const usd = converted.convertedOtherRegionsPrice?.usdPrice;
    const eur = converted.convertedOtherRegionsPrice?.eurPrice;
    if (usd === undefined || eur === undefined) {
      throw new Error(
        'Google Play price conversion returned no USD and EUR prices for new regions.',
      );
    }
    // Prices follow the file; a region's availability stays as Play has it.
    const remoteRegions = remoteOption?.regionalPricingAndAvailabilityConfigs ?? [];
    for (const config of remoteRegions) {
      const desired = typeof config.regionCode === 'string'
        ? byRegion.get(config.regionCode)
        : undefined;
      if (desired !== undefined && typeof config.availability === 'string'
        && config.availability !== desired.availability) {
        byRegion.set(String(config.regionCode), { ...desired, availability: config.availability });
      }
    }
    const keptRegions = remoteRegions.filter(
      (config) => typeof config.regionCode === 'string' && !byRegion.has(config.regionCode),
    );
    if (keptRegions.length > 0) {
      notes.push(`Play keeps ${keptRegions.length} region(s) the conversion does not list: ${
        keptRegions.map((config) => String(config.regionCode)).join(', ')}.`);
    }
    // New regions: a new option opts in; an existing one keeps its choice.
    const remoteNewRegions = remoteOption === undefined ? undefined : remoteOption.newRegionsConfig;
    pricing = {
      regional: sortRegions([...byRegion.values(), ...keptRegions]),
      newRegions: remoteOption !== undefined && remoteNewRegions === undefined
        ? undefined
        : {
            usdPrice: normalizeMoney(usd),
            eurPrice: normalizeMoney(eur),
            availability: remoteNewRegions?.availability ?? 'AVAILABLE',
          },
      regionsVersion,
    };
  }

  const live = remoteOption?.state === 'ACTIVE';
  if (remoteOption?.state === 'INACTIVE' || remoteOption?.state === 'INACTIVE_PUBLISHED') {
    notes.push(
      `Purchase option ${purchaseOptionId} is ${remoteOption.state} on Play; the sync does not reactivate it.`,
    );
  }
  const otherLegacy = remoteOptions.some((option) =>
    option.purchaseOptionId !== purchaseOptionId && option.buyOption?.legacyCompatible === true,
  );
  const baseOption: PlayPurchaseOption = remoteOption === undefined
    ? {
        purchaseOptionId,
        // Play Billing Library 7 and older see only the legacy-compatible buy option.
        buyOption: { legacyCompatible: !otherLegacy },
      }
    : withoutState(remoteOption);
  let desiredOption: PlayPurchaseOption = {
    ...baseOption,
    buyOption: {
      ...baseOption.buyOption,
      ...(googlePlay.multiQuantity === undefined ? {} : { multiQuantityEnabled: googlePlay.multiQuantity }),
    },
    ...(pricing === undefined ? {} : {
      regionalPricingAndAvailabilityConfigs: pricing.regional,
      ...(pricing.newRegions === undefined ? {} : { newRegionsConfig: pricing.newRegions }),
    }),
  };

  const changes: PlayProductChange[] = [];
  const isNewOption = remoteOption === undefined;
  if (remote === undefined) {
    changes.push('listings', 'prices', 'purchase-option');
  } else {
    if (!sameListings(remote.listings ?? [], listings)) {
      changes.push('listings');
    }
    if (isNewOption) {
      changes.push('purchase-option', 'prices');
    } else if (pricing !== undefined && !samePricing(remoteOption, desiredOption)) {
      changes.push('prices');
    }
  }
  if (!isNewOption && googlePlay.multiQuantity !== undefined
    && (remoteOption.buyOption?.multiQuantityEnabled ?? false) !== googlePlay.multiQuantity) {
    changes.push('multi-quantity');
  }
  const taxCategory = googlePlay.productTaxCategoryCode;
  if (taxCategory !== undefined && remote?.taxAndComplianceSettings?.productTaxCategoryCode !== taxCategory) {
    changes.push('tax-category');
  }
  let livePriceChange = live && changes.includes('prices');
  let pricesHeld = false;
  if (livePriceChange && input.keepLivePrices && remoteOption !== undefined) {
    pricesHeld = true;
    desiredOption = {
      ...desiredOption,
      regionalPricingAndAvailabilityConfigs: remoteOption.regionalPricingAndAvailabilityConfigs,
      newRegionsConfig: remoteOption.newRegionsConfig,
    };
    changes.splice(changes.indexOf('prices'), 1);
    livePriceChange = false;
    notes.push('A price change on this live product is held (--keep-live-prices).');
  }
  const priceChanges = changes.includes('prices') ? diffPrices(remoteOption, desiredOption) : [];
  if (isNewOption || remoteOption.state === 'DRAFT') {
    if ((desiredOption.regionalPricingAndAvailabilityConfigs ?? []).length === 0) {
      notes.push(
        `Purchase option ${purchaseOptionId} has no prices on Play; give googlePlay.price to activate it.`,
      );
    } else {
      changes.push('activate');
    }
  }

  const remoteSha256 = remote === undefined ? null : stableSha256(remote);
  if (changes.length === 0) {
    return {
      logicalId: input.logicalId,
      productId,
      action: 'unchanged',
      changes,
      purchaseOptionId,
      live,
      livePriceChange: false,
      priceChanges: [],
      notes,
      remoteSha256,
      desiredSha256: stableSha256({ productId, listings, desiredOption }),
    };
  }

  const mask = new Set<string>();
  if (changes.includes('listings')) {
    mask.add('listings');
  }
  if (changes.some(
    (change) => change === 'prices' || change === 'purchase-option' || change === 'multi-quantity',
  )) {
    mask.add('purchaseOptions');
  }
  if (changes.includes('tax-category')) {
    mask.add('taxAndComplianceSettings');
  }
  const purchaseOptions = isNewOption
    ? [...remoteOptions.map(withoutState), desiredOption]
    : remoteOptions.map((option) =>
        option.purchaseOptionId === purchaseOptionId ? desiredOption : withoutState(option),
      );
  const { regionsVersion: _remoteVersion, ...remoteFields } = remote ?? {};
  const product: PlayOneTimeProduct = {
    ...remoteFields,
    packageName: input.packageName,
    productId,
    listings,
    purchaseOptions,
    ...(taxCategory === undefined && remote?.taxAndComplianceSettings === undefined ? {} : {
      taxAndComplianceSettings: {
        ...remote?.taxAndComplianceSettings,
        ...(taxCategory === undefined ? {} : { productTaxCategoryCode: taxCategory }),
      },
    }),
  };
  // Prices written from the conversion go with its regions version; a patch
  // that sends Play's own prices back keeps the version Play reported.
  const regionsVersion = pricing !== undefined && !pricesHeld
    && (mask.has('purchaseOptions') || remote === undefined)
    ? pricing.regionsVersion
    : (remote?.regionsVersion?.version ?? pricing?.regionsVersion);
  if (mask.size > 0 && (regionsVersion === undefined || regionsVersion === null || regionsVersion === '')) {
    throw new Error(`${label}: no regions version is known for the update; give googlePlay.price.`);
  }
  const write: PlayProductWrite = {
    ...(mask.size === 0 ? {} : {
      patch: {
        product,
        updateMask: [...mask].join(','),
        allowMissing: remote === undefined,
        regionsVersion: String(regionsVersion),
      },
    }),
    ...(changes.includes('activate') ? { activatePurchaseOptionId: purchaseOptionId } : {}),
  };
  return {
    logicalId: input.logicalId,
    productId,
    action: remote === undefined ? 'create' : 'update',
    changes,
    purchaseOptionId,
    live,
    livePriceChange,
    priceChanges,
    notes,
    remoteSha256,
    desiredSha256: stableSha256({ changes, write }),
    write,
  };
}

export interface PlayProductApplyResult {
  readonly packageName: string;
  readonly products: readonly {
    readonly productId: string;
    readonly status: 'created' | 'updated' | 'activated' | 'unchanged';
  }[];
}

export class PlayProductApplyError extends Error {
  constructor(
    readonly productId: string,
    readonly stage: 'patch' | 'activate',
    readonly done: PlayProductApplyResult['products'],
    cause: unknown,
  ) {
    super(
      `Google Play ${stage} of ${productId} failed or its result is unknown (${
        cause instanceof Error ? cause.message : String(cause)}). Products already written: ${
        done.map((entry) => entry.productId).join(', ') || 'none'}. Run "mpgd store products plan" `
      + 'again: it reads Play and lists what is left; writing the same product again is safe.',
      { cause },
    );
    this.name = 'PlayProductApplyError';
  }
}

/**
 * Apply a reviewed plan. `current` is a fresh plan from the same inputs:
 * apply writes only when every product it would change still has the
 * remote state and the planned write the reviewer saw. A product that is
 * now unchanged (an earlier apply landed) is skipped, so a re-run is safe.
 */
export async function applyPlayProductPlan(input: {
  readonly saved: PlayProductPlan;
  readonly current: PlayProductPlan;
  readonly port: PlayProductCatalogPort;
  readonly approved: boolean;
  readonly confirmPriceChange?: boolean;
  readonly signal?: AbortSignal;
}): Promise<PlayProductApplyResult> {
  const { saved, current } = input;
  if (!input.approved) {
    throw new Error('Writing Google Play products requires --approve.');
  }
  if (saved.packageName !== current.packageName || saved.catalogTarget !== current.catalogTarget
    || saved.keepLivePrices !== current.keepLivePrices) {
    throw new StoreProductPlanStaleError(
      'The saved plan was made for another app or other options.',
    );
  }
  const savedById = new Map(saved.products.map((product) => [product.productId, product]));
  const pending = current.products.filter((product) => product.action !== 'unchanged');
  for (const product of pending) {
    const reviewed = savedById.get(product.productId);
    if (reviewed === undefined || reviewed.action !== product.action
      || reviewed.remoteSha256 !== product.remoteSha256
      || reviewed.desiredSha256 !== product.desiredSha256) {
      throw new StoreProductPlanStaleError(
        `Google Play product ${product.productId} changed on Play or in the game files since the plan.`,
      );
    }
  }
  const priced = pending.filter((product) => product.livePriceChange);
  if (priced.length > 0 && input.confirmPriceChange !== true) {
    throw new Error(
      `The plan changes the price of live Google Play products (${
        priced.map((product) => product.productId).join(', ')}); confirm with --confirm-price-change, `
      + 'or plan again with --keep-live-prices.',
    );
  }
  const done: { productId: string; status: 'created' | 'updated' | 'activated' | 'unchanged' }[] = [];
  for (const product of current.products) {
    if (product.action === 'unchanged' || product.write === undefined) {
      done.push({ productId: product.productId, status: 'unchanged' });
      continue;
    }
    input.signal?.throwIfAborted();
    const { patch, activatePurchaseOptionId } = product.write;
    if (patch !== undefined) {
      try {
        await input.port.patchOneTimeProduct({
          packageName: current.packageName,
          productId: product.productId,
          product: patch.product,
          updateMask: patch.updateMask,
          allowMissing: patch.allowMissing,
          regionsVersion: patch.regionsVersion,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        throw new PlayProductApplyError(product.productId, 'patch', done, error);
      }
    }
    if (activatePurchaseOptionId !== undefined) {
      try {
        await input.port.activatePurchaseOption({
          packageName: current.packageName,
          productId: product.productId,
          purchaseOptionId: activatePurchaseOptionId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        throw new PlayProductApplyError(product.productId, 'activate', done, error);
      }
    }
    done.push({
      productId: product.productId,
      status: product.action === 'create'
        ? 'created'
        : patch === undefined
          ? 'activated'
          : 'updated',
    });
  }
  return { packageName: current.packageName, products: done };
}

/** One line per product for the terminal. */
export function formatPlayProductPlan(plan: PlayProductPlan): string {
  const lines = [`Google Play ${plan.packageName} (catalog target ${plan.catalogTarget})`];
  for (const product of plan.products) {
    const flags = [
      product.live ? 'live' : undefined,
      product.livePriceChange ? 'PRICE CHANGE ON LIVE PRODUCT' : undefined,
    ].filter((flag) => flag !== undefined);
    lines.push(`  ${product.action.padEnd(9)} ${product.productId} (${product.logicalId})${
      product.changes.length === 0 ? '' : `: ${product.changes.join(', ')}`}${
      flags.length === 0 ? '' : ` [${flags.join('; ')}]`}`);
    const shown = product.priceChanges.slice(0, maxPrintedPriceChanges);
    for (const change of shown) {
      lines.push(
        `            price ${change.region}: ${change.from ?? '-'} -> ${change.to ?? '-'}`,
      );
    }
    if (product.priceChanges.length > shown.length) {
      lines.push(
        `            ... ${product.priceChanges.length - shown.length} more price changes in the plan file`,
      );
    }
    for (const note of product.notes) {
      lines.push(`            note: ${note}`);
    }
  }
  for (const entry of plan.skipped) {
    lines.push(`  skipped   ${entry.productId ?? '-'} (${entry.logicalId}): ${entry.reason}`);
  }
  for (const productId of plan.remoteOnly) {
    lines.push(`  remote    ${productId}: only on Play; not in the catalog (never deleted)`);
  }
  return lines.join('\n');
}

function toPlayMoney(money: StoreListingMoney): PlayMoney {
  return { currencyCode: money.currency, ...decimalToUnitsAndNanos(money.amount) };
}

function normalizeMoney(money: PlayMoney): PlayMoney {
  return {
    currencyCode: money.currencyCode ?? undefined,
    units: money.units === undefined || money.units === null || money.units === ''
      ? '0'
      : BigInt(money.units).toString(),
    nanos: money.nanos ?? 0,
  };
}

function sameMoney(left: PlayMoney | undefined, right: PlayMoney | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return stableJson(normalizeMoney(left)) === stableJson(normalizeMoney(right));
}

function samePricing(remote: PlayPurchaseOption, desired: PlayPurchaseOption): boolean {
  const index = (configs: readonly PlayRegionalPricingConfig[] | undefined): Map<string, PlayRegionalPricingConfig> =>
    new Map((configs ?? []).map((config) => [String(config.regionCode), config]));
  const left = index(remote.regionalPricingAndAvailabilityConfigs);
  const right = index(desired.regionalPricingAndAvailabilityConfigs);
  if (left.size !== right.size) {
    return false;
  }
  for (const [region, config] of right) {
    const other = left.get(region);
    if (other === undefined || other.availability !== config.availability
      || !sameMoney(other.price, config.price)) {
      return false;
    }
  }
  const a = remote.newRegionsConfig;
  const b = desired.newRegionsConfig;
  return a?.availability === b?.availability
    && sameMoney(a?.usdPrice, b?.usdPrice)
    && sameMoney(a?.eurPrice, b?.eurPrice);
}

function diffPrices(
  remote: PlayPurchaseOption | undefined,
  desired: PlayPurchaseOption,
): PlayPriceChange[] {
  const describe = (config: PlayRegionalPricingConfig | undefined): string | undefined =>
    config === undefined
      ? undefined
      : `${formatMoney(config.price)}${config.availability === 'AVAILABLE' ? '' : ` (${String(config.availability)})`}`;
  const left = new Map(
    (remote?.regionalPricingAndAvailabilityConfigs ?? []).map((config) => [
      String(config.regionCode),
      config,
    ]),
  );
  const right = new Map(
    (desired.regionalPricingAndAvailabilityConfigs ?? []).map((config) => [
      String(config.regionCode),
      config,
    ]),
  );
  const changes: PlayPriceChange[] = [];
  for (const region of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const from = describe(left.get(region));
    const to = describe(right.get(region));
    if (from !== to) {
      changes.push({
        region,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      });
    }
  }
  const newRegions = (config: PlayNewRegionsConfig | undefined): string | undefined =>
    config === undefined
      ? undefined
      : `${formatMoney(config.usdPrice)} / ${formatMoney(config.eurPrice)} (${String(config.availability)})`;
  const fromNew = newRegions(remote?.newRegionsConfig);
  const toNew = newRegions(desired.newRegionsConfig);
  if (fromNew !== toNew) {
    changes.push({
      region: 'new-regions',
      ...(fromNew === undefined ? {} : { from: fromNew }),
      ...(toNew === undefined ? {} : { to: toNew }),
    });
  }
  return changes;
}

function formatMoney(money: PlayMoney | undefined): string {
  if (money === undefined) {
    return '?';
  }
  const normal = normalizeMoney(money);
  const nanos = String(normal.nanos ?? 0).padStart(9, '0').replace(/0+$/u, '');
  return `${String(normal.units)}${nanos === '' ? '' : `.${nanos}`} ${String(normal.currencyCode)}`;
}

function sameListings(
  remote: readonly PlayOneTimeProductListing[],
  desired: readonly PlayOneTimeProductListing[],
): boolean {
  const normal = (listings: readonly PlayOneTimeProductListing[]): string => stableJson(
    sortListings(listings).map((listing) => ({
      languageCode: listing.languageCode,
      title: listing.title,
      description: listing.description,
    })),
  );
  return normal(remote) === normal(desired);
}

function sortListings(listings: readonly PlayOneTimeProductListing[]): PlayOneTimeProductListing[] {
  return [...listings].sort((left, right) =>
    String(left.languageCode).localeCompare(String(right.languageCode)),
  );
}

function sortRegions(configs: readonly PlayRegionalPricingConfig[]): PlayRegionalPricingConfig[] {
  return [...configs].sort((left, right) =>
    String(left.regionCode).localeCompare(String(right.regionCode)),
  );
}

function withoutState(option: PlayPurchaseOption): PlayPurchaseOption {
  const { state: _state, ...rest } = option;
  return rest;
}

function fold(value: string | null | undefined): string {
  return String(value).toLowerCase();
}
