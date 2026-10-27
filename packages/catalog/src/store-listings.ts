import typia, { type tags } from 'typia';

import type { ProductCatalog } from './index.js';

/**
 * Store listing metadata for one-time products: what Google Play and App
 * Store Connect need before a product can be bought (titles, descriptions,
 * prices, review material). It lives in its own file, next to the product
 * catalog, because the catalog JSON is bundled into game clients and this
 * file is not: review notes and pricing intent never ship to players. The
 * runtime never reads it; only the `mpgd store products` sync does.
 */

/** BCP-47 language tag as both stores write it, for example `en-US` or `ko-KR`. */
export type StoreListingLocale = string;

export interface StoreListingLocalization {
  readonly title: string & tags.MinLength<1>;
  readonly description: string & tags.MinLength<1>;
}

/**
 * An amount in one currency. `amount` is a decimal string (`"0.99"`,
 * `"1200"`) so no price passes through floating point.
 */
export interface StoreListingMoney {
  /** ISO 4217 code, for example `USD`. */
  readonly currency: string & tags.Pattern<'^[A-Z]{3}$'>;
  readonly amount: string & tags.Pattern<'^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,9})?$'>;
}

export interface GooglePlayListingPrice {
  /**
   * Tax-exclusive base price. Google Play converts it into every region it
   * sells in (`monetization.convertRegionPrices`), including the USD and EUR
   * prices for regions Play launches later.
   */
  readonly base: StoreListingMoney;
  /**
   * Explicit prices that replace the converted price of a region, keyed by
   * ISO 3166-1 alpha-2 region code (`KR`). Each must be in that region's
   * currency, and is the **tax-inclusive** price players pay there: it
   * replaces Play's converted price, which `convertRegionPrices` returns
   * tax inclusive. A tax-exclusive figure would undercharge by the tax.
   */
  readonly regions?: Readonly<Record<string, StoreListingMoney>>;
}

export interface GooglePlayListing {
  /** Replaces the shared localizations on Google Play when given. */
  readonly localizations?: Readonly<Record<StoreListingLocale, StoreListingLocalization>>;
  readonly price?: GooglePlayListingPrice;
  /**
   * The purchase option the sync manages. Defaults to the product's only
   * buy option when it already exists, or `buy` for a new product.
   */
  readonly purchaseOptionId?: string & tags.Pattern<'^[a-z0-9][a-z0-9-]{0,62}$'>;
  /** Play product tax category code; left to Play's default when absent. */
  readonly productTaxCategoryCode?: string & tags.MinLength<1>;
}

export interface AppStoreListingPrice {
  /** App Store territory (ISO 3166-1 alpha-3, for example `USA`) of the base price. */
  readonly baseTerritory: string & tags.Pattern<'^[A-Z]{3}$'>;
  /**
   * Customer price in the base territory's currency. It must match one of
   * Apple's price points there; Apple derives the other territories from it.
   */
  readonly customerPrice: string & tags.Pattern<'^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,9})?$'>;
  /** Manual customer prices that replace Apple's equalized price of a territory. */
  readonly territories?: Readonly<Record<string, string & tags.Pattern<'^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,9})?$'>>>;
}

export interface AppStoreListing {
  /** Replaces the shared localizations on the App Store when given. */
  readonly localizations?: Readonly<Record<StoreListingLocale, StoreListingLocalization>>;
  /**
   * App Store Connect reference name. When absent, an existing in-app
   * purchase keeps its name and a new one is named after the logical
   * product ID.
   */
  readonly referenceName?: string & tags.MinLength<1>;
  readonly price?: AppStoreListingPrice;
  /** Notes for App Review. Not shown to customers. */
  readonly reviewNote?: string & tags.MinLength<1>;
  /** Review screenshot, relative to the listing file. */
  readonly reviewScreenshot?: string & tags.MinLength<1>;
  /** Family Sharing; Apple allows it for non-consumables only. */
  readonly familySharable?: boolean;
  /**
   * Territories (ISO 3166-1 alpha-3) a new in-app purchase is sold in, and
   * whether territories Apple adds later are included. Defaults to every
   * App Store territory and new territories.
   */
  readonly availability?: AppStoreListingAvailability;
}

export interface AppStoreListingAvailability {
  readonly territories?: readonly (string & tags.Pattern<'^[A-Z]{3}$'>)[] & tags.MinItems<1>;
  readonly availableInNewTerritories?: boolean;
}

export interface StoreListingEntry {
  /** Shared store title and description per language. */
  readonly localizations: Readonly<Record<StoreListingLocale, StoreListingLocalization>>;
  readonly googlePlay?: GooglePlayListing;
  readonly appStore?: AppStoreListing;
}

export interface StoreListingCatalog {
  readonly version: string & tags.MinLength<1>;
  /** Keyed by the logical product ID of the product catalog. */
  readonly products: Readonly<Record<string, StoreListingEntry>>;
}

const assertStoreListingCatalogShape = typia.createAssert<StoreListingCatalog>();

const localePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const regionPattern = /^[A-Z]{2}$/u;
const territoryPattern = /^[A-Z]{3}$/u;

/**
 * Validate a store listing file. With the product catalog it also checks that
 * every listed product exists, and that listings are given only for one-time
 * products (subscriptions stay outside the sync).
 */
export function assertStoreListingCatalog(
  input: unknown,
  catalog?: ProductCatalog,
): StoreListingCatalog {
  const listings = assertStoreListingCatalogShape(input);
  const products = new Map(catalog?.products.map((product) => [product.id, product]));
  for (const [productId, entry] of Object.entries(listings.products)) {
    if (catalog !== undefined) {
      const product = products.get(productId);
      if (product === undefined) {
        throw new Error(`Store listing ${productId} names no product of the catalog.`);
      }
      if (product.type === 'subscription') {
        throw new Error(
          `Store listing ${productId} is a subscription; the store product sync covers one-time products only.`,
        );
      }
      if (entry.appStore?.familySharable === true && product.type !== 'non_consumable') {
        throw new Error(
          `Store listing ${productId}: Family Sharing applies to non-consumables only.`,
        );
      }
    }
    assertLocalizations(productId, 'localizations', entry.localizations);
    if (entry.googlePlay?.localizations !== undefined) {
      assertLocalizations(productId, 'googlePlay.localizations', entry.googlePlay.localizations);
    }
    if (entry.appStore?.localizations !== undefined) {
      assertLocalizations(productId, 'appStore.localizations', entry.appStore.localizations);
    }
    for (const region of Object.keys(entry.googlePlay?.price?.regions ?? {})) {
      if (!regionPattern.test(region)) {
        throw new Error(
          `Store listing ${productId}: googlePlay.price.regions key ${region} must be an ISO 3166-1 alpha-2 code.`,
        );
      }
    }
    for (const territory of Object.keys(entry.appStore?.price?.territories ?? {})) {
      if (!territoryPattern.test(territory)) {
        throw new Error(
          `Store listing ${productId}: appStore.price.territories key ${territory} must be an ISO 3166-1 alpha-3 code.`,
        );
      }
      if (territory === entry.appStore?.price?.baseTerritory) {
        throw new Error(
          `Store listing ${productId}: the base territory ${territory} is priced by customerPrice, not territories.`,
        );
      }
    }
    const availability = entry.appStore?.availability?.territories ?? [];
    if (new Set(availability).size !== availability.length) {
      throw new Error(
        `Store listing ${productId}: appStore.availability.territories lists a territory twice.`,
      );
    }
    const screenshot = entry.appStore?.reviewScreenshot;
    if (screenshot !== undefined && !isRelativeChildPath(screenshot)) {
      throw new Error(
        `Store listing ${productId}: appStore.reviewScreenshot must be a relative path inside the game.`,
      );
    }
  }
  return listings;
}

/** The localizations a store uses: its own override, or the shared map. */
export function resolveStoreListingLocalizations(
  entry: StoreListingEntry,
  store: 'googlePlay' | 'appStore',
): Readonly<Record<StoreListingLocale, StoreListingLocalization>> {
  return entry[store]?.localizations ?? entry.localizations;
}

function assertLocalizations(
  productId: string,
  field: string,
  localizations: Readonly<Record<string, StoreListingLocalization>>,
): void {
  const locales = Object.keys(localizations);
  if (locales.length === 0) {
    throw new Error(`Store listing ${productId}: ${field} needs at least one language.`);
  }
  const seen = new Set<string>();
  for (const locale of locales) {
    if (!localePattern.test(locale)) {
      throw new Error(
        `Store listing ${productId}: ${field} key ${locale} is not a BCP-47 language tag.`,
      );
    }
    const folded = locale.toLowerCase();
    if (seen.has(folded)) {
      throw new Error(`Store listing ${productId}: ${field} lists ${locale} twice.`);
    }
    seen.add(folded);
    const text = localizations[locale];
    if (text === undefined || text.title.trim() !== text.title || text.description.trim() !== text.description
      || text.title.trim() === '' || text.description.trim() === '') {
      throw new Error(
        `Store listing ${productId}: ${field}.${locale} title and description must be trimmed and non-empty.`,
      );
    }
  }
}

function isRelativeChildPath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value)) {
    return false;
  }
  return !value.split(/[\\/]/u).some((segment) => segment === '..');
}
