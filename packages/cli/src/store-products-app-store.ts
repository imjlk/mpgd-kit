import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  resolveProductPlatformId,
  resolveStoreListingLocalizations,
  type ProductCatalog,
  type StoreListingCatalog,
} from '@mpgd/catalog';

import type {
  AscIap,
  AscIapLocalization,
  AscIapPort,
  AscIapPriceSchedule,
  AscIapReviewScreenshot,
  AscIapType,
  AscIapVersion,
} from './app-store-iap-port.js';
import { canonicalLanguageTag } from './store-products-play.js';
import {
  sameDecimal,
  stableSha256,
  StoreProductPlanStaleError,
  type StoreProductAction,
} from './store-products.js';

/**
 * App Store Connect in-app purchase sync: compare the game's catalog and
 * store listing file with App Store Connect and plan the writes. The plan
 * only reads; in-app purchases only on App Store Connect are reported, never
 * deleted; localizations and territories the file does not name are kept.
 * Nothing is submitted for review: an in-app purchase's first review goes
 * with an app version (App Store Connect Help, "Submit an In-App Purchase").
 */

export type AppStoreProductChange =
  | 'create'
  | 'reference-name'
  | 'family-sharing'
  | 'version'
  | 'localizations'
  | 'prices'
  | 'availability'
  | 'review-screenshot';

export interface AppStoreLocalizationEntry {
  readonly locale: string;
  readonly name: string;
  readonly description: string;
}

export interface AppStoreProductWrite {
  readonly create?: {
    readonly type: AscIapType;
    readonly referenceName: string;
    readonly familySharable: boolean;
  };
  readonly update?: { readonly referenceName?: string; readonly familySharable?: true };
  /**
   * Localizations to upsert by locale. `existing` writes to `versionId`;
   * `create` makes a new draft version first (App Store Connect copies the
   * current metadata into it); `resolve` (a new in-app purchase) uses the
   * version App Store Connect provisioned, or creates one.
   */
  readonly localizations?: {
    readonly version: 'existing' | 'create' | 'resolve';
    readonly versionId?: string;
    readonly entries: readonly AppStoreLocalizationEntry[];
  };
  /** A new schedule effective now; the base territory's price comes first. */
  readonly prices?: {
    readonly baseTerritory: string;
    readonly prices: readonly { readonly territory: string; readonly customerPrice: string }[];
  };
  readonly availability?: {
    readonly territories: readonly string[];
    readonly availableInNewTerritories: boolean;
  };
  readonly reviewScreenshot?: {
    /** Absolute path on this checkout. */
    readonly file: string;
    /** Path relative to the listing file, as the file names it. */
    readonly path: string;
    readonly md5: string;
    /** The completed screenshot to delete first (App Store Connect keeps one). */
    readonly replaceId?: string;
  };
}

interface MutableWrite {
  create?: NonNullable<AppStoreProductWrite['create']>;
  update?: NonNullable<AppStoreProductWrite['update']>;
  localizations?: NonNullable<AppStoreProductWrite['localizations']>;
  prices?: NonNullable<AppStoreProductWrite['prices']>;
  availability?: NonNullable<AppStoreProductWrite['availability']>;
  reviewScreenshot?: NonNullable<AppStoreProductWrite['reviewScreenshot']>;
}

export interface AppStorePriceChange {
  /** Alpha-3 territory, or `base-territory`. */
  readonly territory: string;
  readonly from?: string;
  readonly to?: string;
}

export interface PlannedAppStoreProduct {
  readonly logicalId: string;
  readonly productId: string;
  readonly action: StoreProductAction;
  readonly changes: readonly AppStoreProductChange[];
  readonly iapId?: string;
  readonly state?: string;
  /** `APPROVED`: the in-app purchase is on sale wherever the app is. */
  readonly live: boolean;
  readonly livePriceChange: boolean;
  readonly priceChanges: readonly AppStorePriceChange[];
  readonly notes: readonly string[];
  readonly remoteSha256: string | null;
  readonly desiredSha256: string;
  readonly write?: AppStoreProductWrite;
}

export interface AppStoreProductPlan {
  readonly schemaVersion: 1;
  readonly store: 'app-store';
  /** Numeric App Store Connect app ID. */
  readonly appId: string;
  readonly bundleId: string;
  readonly catalogTarget: string;
  readonly keepLivePrices: boolean;
  readonly products: readonly PlannedAppStoreProduct[];
  readonly skipped: readonly { readonly logicalId: string; readonly productId?: string; readonly reason: string }[];
  /** Product IDs on App Store Connect that no catalog product names. Never deleted. */
  readonly remoteOnly: readonly string[];
  /** What the sync cannot do; the reviewer does it in App Store Connect. */
  readonly manual: readonly string[];
}

export interface AppStoreProductPlanInput {
  readonly appId: string;
  readonly bundleId: string;
  readonly catalog: ProductCatalog;
  readonly listings: StoreListingCatalog;
  /** Directory of the listing file; review screenshot paths resolve against it. */
  readonly listingsDirectory: string;
  /** Catalog `platformProductIds` key of the App Store; defaults to `ios`. */
  readonly catalogTarget?: string;
  readonly keepLivePrices?: boolean;
}

// App Store Connect Help, "In-App Purchase information": reference name 64,
// product ID 100 (letters, numbers, hyphens, periods, underscores), display
// name 2-30, description 45, review notes 4,000.
const maxReferenceName = 64;
const productIdPattern = /^[A-Za-z0-9._-]{1,100}$/u;
const minDisplayName = 2;
const maxDisplayName = 30;
const maxDescription = 45;
const maxReviewNote = 4000;
// Version states whose localizations App Store Connect still accepts edits for.
const inReviewVersionStates = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW']);
const approvedVersionStates = new Set(['ACCEPTED', 'APPROVED', 'REPLACED_WITH_NEW_VERSION']);
const editableVersionStates = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'REJECTED',
  'DEVELOPER_REJECTED',
]);

export async function planAppStoreProducts(
  input: AppStoreProductPlanInput,
  port: AscIapPort,
): Promise<AppStoreProductPlan> {
  const catalogTarget = input.catalogTarget ?? 'ios';
  const keepLivePrices = input.keepLivePrices === true;
  const bundleId = await port.readAppBundleId(input.appId);
  if (bundleId !== input.bundleId) {
    throw new Error(
      `App Store Connect app ${input.appId} has bundle ID ${bundleId}, not ${input.bundleId} from the deployment profile.`,
    );
  }
  const remote = await port.listIaps(input.appId);
  const remoteByProductId = new Map(remote.map((iap) => [iap.productId, iap]));
  let territories: Promise<string[]> | undefined;
  const allTerritories = (): Promise<string[]> => {
    territories ??= port.listTerritories();
    return territories;
  };

  const products: PlannedAppStoreProduct[] = [];
  const skipped: AppStoreProductPlan['skipped'][number][] = [];
  const manual: string[] = [];
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
        `App Store product ID ${productId} (${product.id}) may hold up to 100 letters, digits, ".", "-" and "_".`,
      );
    }
    const type: AscIapType = product.type === 'consumable' ? 'CONSUMABLE' : 'NON_CONSUMABLE';
    const planned = await planOne({
      logicalId: product.id,
      productId,
      type,
      entry,
      remote: remoteByProductId.get(productId),
      listingsDirectory: input.listingsDirectory,
      keepLivePrices,
      allTerritories,
      port,
      manual,
    });
    products.push(planned);
  }
  const remoteOnly = remote
    .map((iap) => iap.productId)
    .filter((productId) => !named.has(productId))
    .sort();
  if (products.some((product) => product.action !== 'unchanged' || product.state !== 'APPROVED')) {
    manual.push(
      'Submit the in-app purchases for App Review in App Store Connect. The first consumable and the '
      + 'first non-consumable must each go with a new app version (version page > In-App Purchases); '
      + 'the sync never submits.',
    );
  }
  return {
    schemaVersion: 1,
    store: 'app-store',
    appId: input.appId,
    bundleId,
    catalogTarget,
    keepLivePrices,
    products,
    skipped,
    remoteOnly,
    manual,
  };
}

interface PlanOneInput {
  readonly logicalId: string;
  readonly productId: string;
  readonly type: AscIapType;
  readonly entry: StoreListingCatalog['products'][string];
  readonly remote: AscIap | undefined;
  readonly listingsDirectory: string;
  readonly keepLivePrices: boolean;
  readonly allTerritories: () => Promise<string[]>;
  readonly port: AscIapPort;
  readonly manual: string[];
}

async function planOne(input: PlanOneInput): Promise<PlannedAppStoreProduct> {
  const { productId, remote, port } = input;
  const appStore = input.entry.appStore ?? {};
  const label = `App Store product ${productId} (${input.logicalId})`;
  const notes: string[] = [];
  const changes: AppStoreProductChange[] = [];

  const referenceName = appStore.referenceName ?? input.logicalId;
  if ([...referenceName].length > maxReferenceName) {
    throw new Error(`${label}: the reference name is longer than ${maxReferenceName} characters.`);
  }
  const desiredLocalizations = Object.entries(resolveStoreListingLocalizations(input.entry, 'appStore'))
    .map(([locale, text]): AppStoreLocalizationEntry => {
      const nameLength = [...text.title].length;
      if (nameLength < minDisplayName || nameLength > maxDisplayName) {
        throw new Error(
          `${label}: the ${locale} display name must be ${minDisplayName}-${maxDisplayName} characters.`,
        );
      }
      if ([...text.description].length > maxDescription) {
        throw new Error(`${label}: the ${locale} description is longer than ${maxDescription} characters.`);
      }
      return { locale: canonicalLanguageTag(locale), name: text.title, description: text.description };
    })
    .sort((left, right) => left.locale.localeCompare(right.locale));
  if (appStore.reviewNote !== undefined && [...appStore.reviewNote].length > maxReviewNote) {
    throw new Error(`${label}: the review note is longer than ${maxReviewNote} characters.`);
  }
  const screenshot = appStore.reviewScreenshot === undefined
    ? undefined
    : readScreenshot(input.listingsDirectory, appStore.reviewScreenshot, label);

  if (remote !== undefined && remote.inAppPurchaseType !== input.type) {
    throw new Error(
      `${label} is ${remote.inAppPurchaseType} on App Store Connect but ${input.type} in the catalog; `
      + 'App Store Connect cannot change the type.',
    );
  }
  const write: MutableWrite = {};

  // The in-app purchase itself.
  if (remote === undefined) {
    changes.push('create');
    write.create = { type: input.type, referenceName, familySharable: appStore.familySharable === true };
  } else {
    const update: { referenceName?: string; familySharable?: true } = {};
    if (remote.name !== referenceName) {
      changes.push('reference-name');
      update.referenceName = referenceName;
    }
    if (appStore.familySharable === true && remote.familySharable !== true) {
      changes.push('family-sharing');
      update.familySharable = true;
      notes.push('Family Sharing cannot be turned off again once it is on.');
    } else if (appStore.familySharable !== true && remote.familySharable === true) {
      notes.push(
        'Family Sharing is on in App Store Connect and cannot be turned off; the file does not ask for it.',
      );
    }
    if (Object.keys(update).length > 0) {
      write.update = update;
    }
  }
  if ((appStore.reviewNote ?? '') !== (remote?.reviewNote ?? '') && appStore.reviewNote !== undefined) {
    input.manual.push(
      `Set the review note of ${productId} in App Store Connect (asc 5.5.0 cannot write it).`,
    );
    notes.push('The review note differs; it is listed under manual steps.');
  }

  // Localizations live on the in-app purchase version (API 4.4.1).
  let versions: AscIapVersion[] = [];
  let baseLocalizations: AscIapLocalization[] = [];
  if (remote === undefined) {
    if (desiredLocalizations.length > 0) {
      changes.push('localizations');
      write.localizations = { version: 'resolve', entries: desiredLocalizations };
    }
  } else {
    versions = [...await port.listVersions(remote.id)]
      .sort((left, right) => (right.version ?? 0) - (left.version ?? 0) || left.id.localeCompare(right.id));
    const editable = versions.filter((version) => editableVersionStates.has(String(version.state)));
    if (editable.length > 1) {
      throw new Error(
        `${label} has ${editable.length} editable in-app purchase versions; finish or remove all but one in App Store Connect.`,
      );
    }
    const target = editable[0];
    const base = target ?? versions[0];
    baseLocalizations = base === undefined
      ? []
      : [...await port.listLocalizations(base.id)].sort((left, right) => left.locale.localeCompare(right.locale));
    const byLocale = new Map(
      baseLocalizations.map((localization) => [localization.locale.toLowerCase(), localization]),
    );
    const changed = desiredLocalizations.filter((desired) => {
      const current = byLocale.get(desired.locale.toLowerCase());
      return current === undefined || current.name !== desired.name
        || (current.description ?? '') !== desired.description;
    });
    const kept = baseLocalizations.filter((localization) =>
      !desiredLocalizations.some((desired) => desired.locale.toLowerCase() === localization.locale.toLowerCase()),
    );
    if (kept.length > 0) {
      notes.push(`App Store Connect keeps localizations the file does not name: ${
        kept.map((localization) => localization.locale).join(', ')}.`);
    }
    if (changed.length > 0 && target === undefined && base !== undefined
      && inReviewVersionStates.has(String(base.state))) {
      notes.push(
        `Version ${String(base.version ?? '?')} is ${String(base.state)}; change the text after App Review answers.`,
      );
    } else if (changed.length > 0) {
      changes.push('localizations');
      if (target !== undefined) {
        write.localizations = { version: 'existing', versionId: target.id, entries: changed };
      } else {
        changes.push('version');
        write.localizations = { version: versions.length === 0 ? 'resolve' : 'create', entries: changed };
        if (versions.length > 0) {
          notes.push(
            `Version ${String(base?.version ?? '?')} is ${String(base?.state)}; a new draft version carries the `
            + 'changed text and needs App Review.',
          );
        }
      }
    }
  }

  // On sale: the in-app purchase, or any of its versions, passed App Review.
  const live = remote?.state === 'APPROVED'
    || versions.some((version) => approvedVersionStates.has(String(version.state)));

  // Prices: the base territory's customer price, plus manual territory prices.
  // A new schedule replaces the old one: a territory the file does not name
  // goes back to Apple's equalized price.
  const priceChanges: AppStorePriceChange[] = [];
  let schedule: AscIapPriceSchedule | undefined;
  if (remote !== undefined) {
    schedule = await port.readPriceSchedule(remote.id);
  }
  let livePriceChange = false;
  if (appStore.price === undefined) {
    if (remote === undefined || schedule === undefined) {
      notes.push('No appStore.price: the in-app purchase stays unpriced and cannot be submitted.');
    }
  } else {
    const desired = new Map<string, string>([
      [appStore.price.baseTerritory, appStore.price.customerPrice],
      ...Object.entries(appStore.price.territories ?? {}),
    ]);
    const current = new Map(
      (schedule?.manualPrices ?? []).map((price) => [price.territory, price.customerPrice]),
    );
    if (schedule !== undefined && schedule.baseTerritory !== appStore.price.baseTerritory) {
      priceChanges.push({
        territory: 'base-territory',
        ...(schedule.baseTerritory === undefined ? {} : { from: schedule.baseTerritory }),
        to: appStore.price.baseTerritory,
      });
    }
    for (const territory of [...new Set([...current.keys(), ...desired.keys()])].sort()) {
      const from = current.get(territory);
      const to = desired.get(territory);
      if (from === undefined || to === undefined || !sameDecimal(from, to)) {
        priceChanges.push({
          territory,
          ...(from === undefined ? {} : { from }),
          to: to ?? 'equalized',
        });
      }
    }
    if (priceChanges.length > 0 && (schedule?.scheduledChanges ?? 0) > 0) {
      notes.push(
        `App Store Connect has ${String(schedule?.scheduledChanges)} scheduled price change(s); a new schedule `
        + 'would drop them, so the sync leaves the prices alone. Change them in App Store Connect.',
      );
      priceChanges.length = 0;
    } else if (priceChanges.length > 0) {
      if (live && input.keepLivePrices) {
        notes.push('A price change on this live in-app purchase is held (--keep-live-prices).');
        priceChanges.length = 0;
      } else {
        changes.push('prices');
        livePriceChange = live;
        write.prices = {
          baseTerritory: appStore.price.baseTerritory,
          prices: [...desired].map(([territory, customerPrice]) => ({ territory, customerPrice })),
        };
      }
    }
  }

  // Availability: set when there is none; changed only when the file names it.
  const availability = remote === undefined ? undefined : await port.readAvailability(remote.id);
  const desiredAvailability = async (): Promise<NonNullable<AppStoreProductWrite['availability']>> => ({
    territories: [...(appStore.availability?.territories ?? await input.allTerritories())].sort(),
    availableInNewTerritories: appStore.availability?.availableInNewTerritories ?? true,
  });
  if (appStore.availability?.territories !== undefined && appStore.price !== undefined) {
    const sold = new Set(appStore.availability.territories);
    const priced = [appStore.price.baseTerritory, ...Object.keys(appStore.price.territories ?? {})];
    const unsold = priced.filter((territory) => !sold.has(territory));
    if (unsold.length > 0) {
      throw new Error(
        `${label}: priced territories ${unsold.join(', ')} are missing from appStore.availability.`,
      );
    }
  }
  if (availability === undefined) {
    changes.push('availability');
    write.availability = await desiredAvailability();
  } else if (appStore.availability !== undefined) {
    const wanted = await desiredAvailability();
    if (wanted.availableInNewTerritories !== availability.availableInNewTerritories
      || wanted.territories.join(',') !== [...availability.territories].sort().join(',')) {
      changes.push('availability');
      write.availability = wanted;
    }
  }
  if (write.availability !== undefined) {
    notes.push(`Availability: ${write.availability.territories.length} territories, new territories ${
      write.availability.availableInNewTerritories ? 'on' : 'off'}.`);
  }

  // Review screenshot: upload when missing, replace when the bytes differ.
  let remoteScreenshot: AscIapReviewScreenshot | undefined;
  if (remote !== undefined) {
    remoteScreenshot = await port.readReviewScreenshot(remote.id);
  }
  if (screenshot !== undefined) {
    // A failed or never-finished upload keeps its checksum; only a delivered one counts.
    const delivered = remoteScreenshot?.deliveryState === undefined
      || remoteScreenshot.deliveryState === 'COMPLETE'
      || remoteScreenshot.deliveryState === 'UPLOAD_COMPLETE';
    const same = delivered && remoteScreenshot?.sourceFileChecksum?.toLowerCase() === screenshot.md5;
    if (remoteScreenshot !== undefined && !delivered) {
      notes.push(
        `The review screenshot on App Store Connect is ${String(remoteScreenshot.deliveryState)}.`,
      );
    }
    if (!same) {
      changes.push('review-screenshot');
      write.reviewScreenshot = {
        file: screenshot.file,
        path: screenshot.path,
        md5: screenshot.md5,
        ...(remoteScreenshot === undefined ? {} : { replaceId: remoteScreenshot.id }),
      };
    }
  } else if (remoteScreenshot === undefined) {
    notes.push('No appStore.reviewScreenshot: App Review needs one before the first submission.');
  }

  const remoteSha256 = remote === undefined
    ? null
    : stableSha256({
        remote,
        versions,
        baseLocalizations,
        schedule,
        availability,
        remoteScreenshot,
      });
  const action: StoreProductAction = remote === undefined
    ? 'create'
    : changes.length === 0
      ? 'unchanged'
      : 'update';
  return {
    logicalId: input.logicalId,
    productId,
    action,
    changes,
    ...(remote === undefined ? {} : { iapId: remote.id }),
    ...(remote?.state === undefined ? {} : { state: remote.state }),
    live,
    livePriceChange,
    priceChanges,
    notes,
    remoteSha256,
    // The digest names the screenshot by its listing-relative path, so a
    // plan applied from another checkout (`apply --game`) still matches.
    desiredSha256: stableSha256({
      changes,
      write: {
        ...write,
        ...(write.reviewScreenshot === undefined ? {} : {
          reviewScreenshot: { ...write.reviewScreenshot, file: write.reviewScreenshot.path },
        }),
      },
    }),
    ...(changes.length === 0 ? {} : { write }),
  };
}

export interface AppStoreProductApplyResult {
  readonly appId: string;
  readonly products: readonly {
    readonly productId: string;
    readonly status: 'created' | 'updated' | 'unchanged';
    readonly iapId?: string;
  }[];
  readonly manual: readonly string[];
}

export class AppStoreProductApplyError extends Error {
  constructor(
    readonly productId: string,
    readonly stage: string,
    readonly done: AppStoreProductApplyResult['products'],
    cause: unknown,
  ) {
    super(
      `App Store Connect ${stage} of ${productId} failed or its result is unknown (${
        cause instanceof Error ? cause.message : String(cause)}). Products already written: ${
        done.map((entry) => entry.productId).join(', ') || 'none'}. Run "mpgd store products plan" `
      + 'again: it reads App Store Connect and lists what is left.',
      { cause },
    );
    this.name = 'AppStoreProductApplyError';
  }
}

/**
 * Apply a reviewed plan, like the Google Play apply: `current` is a fresh
 * plan, and every product apply would write must still match the reviewed
 * remote state and planned write.
 */
export async function applyAppStoreProductPlan(input: {
  readonly saved: AppStoreProductPlan;
  readonly current: AppStoreProductPlan;
  readonly port: AscIapPort;
  readonly approved: boolean;
  readonly confirmPriceChange?: boolean;
}): Promise<AppStoreProductApplyResult> {
  const { saved, current, port } = input;
  if (!input.approved) {
    throw new Error('Writing App Store Connect in-app purchases requires --approve.');
  }
  if (saved.appId !== current.appId || saved.catalogTarget !== current.catalogTarget
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
        `App Store product ${product.productId} changed in App Store Connect or in the game files since the plan.`,
      );
    }
  }
  const priced = pending.filter((product) => product.livePriceChange);
  if (priced.length > 0 && input.confirmPriceChange !== true) {
    throw new Error(
      `The plan changes the price of approved in-app purchases (${
        priced.map((product) => product.productId).join(', ')}); confirm with --confirm-price-change, `
      + 'or plan again with --keep-live-prices.',
    );
  }
  const done: { productId: string; status: 'created' | 'updated' | 'unchanged'; iapId?: string }[] = [];
  for (const product of current.products) {
    const write = product.write;
    if (product.action === 'unchanged' || write === undefined) {
      done.push({ productId: product.productId, status: 'unchanged' });
      continue;
    }
    let stage = 'start';
    let wrote = false;
    const step = async <T>(name: string, action: () => Promise<T>, writes = true): Promise<T> => {
      stage = name;
      const result = await action();
      wrote ||= writes;
      return result;
    };
    try {
      let iapId = product.iapId;
      if (write.create !== undefined) {
        const create = write.create;
        iapId = await step('create', () => port.createIap({
          appId: current.appId,
          type: create.type,
          referenceName: create.referenceName,
          productId: product.productId,
          familySharable: create.familySharable,
        }));
      }
      if (iapId === undefined) {
        throw new Error('the plan has no in-app purchase ID');
      }
      const id = iapId;
      if (write.update !== undefined) {
        const update = write.update;
        await step('update', () => port.updateIap({ iapId: id, ...update }));
      }
      if (write.localizations !== undefined) {
        const localizations = write.localizations;
        const versionId = await step('version', () => resolveVersion(port, id, localizations));
        const existing = new Map(
          (await step('localizations', () => port.listLocalizations(versionId), false))
            .map((localization) => [localization.locale.toLowerCase(), localization]),
        );
        for (const entry of localizations.entries) {
          const present = existing.get(entry.locale.toLowerCase());
          if (present === undefined) {
            await step('localizations', () => port.createLocalization({ versionId, ...entry }));
          } else if (present.name !== entry.name || (present.description ?? '') !== entry.description) {
            await step('localizations', () =>
              port.updateLocalization({
                localizationId: present.id,
                name: entry.name,
                description: entry.description,
              }),
            );
          }
        }
      }
      if (write.prices !== undefined) {
        const prices = write.prices;
        const pricePointIds: string[] = [];
        for (const price of prices.prices) {
          pricePointIds.push(await step('prices', () => port.findPricePoint({
            iapId: id,
            territory: price.territory,
            customerPrice: price.customerPrice,
          }), false));
        }
        await step('prices', () =>
          port.createPriceSchedule({
            iapId: id,
            baseTerritory: prices.baseTerritory,
            pricePointIds,
          }),
        );
      }
      if (write.availability !== undefined) {
        const availability = write.availability;
        await step('availability', () => port.setAvailability({ iapId: id, ...availability }));
      }
      if (write.reviewScreenshot !== undefined) {
        const screenshot = write.reviewScreenshot;
        if (md5File(screenshot.file) !== screenshot.md5) {
          throw new StoreProductPlanStaleError(
            `Review screenshot ${screenshot.file} changed since the plan.`,
          );
        }
        if (screenshot.replaceId !== undefined) {
          const replaceId = screenshot.replaceId;
          await step('review-screenshot', () => port.deleteReviewScreenshot(replaceId));
        }
        await step('review-screenshot', () =>
          port.uploadReviewScreenshot({ iapId: id, file: screenshot.file }),
        );
      }
      done.push({
        productId: product.productId,
        status: product.action === 'create' ? 'created' : 'updated',
        iapId: id,
      });
    } catch (error) {
      if (error instanceof StoreProductPlanStaleError) {
        throw error;
      }
      // Only products something was written for count as "already written".
      const written = done.filter((entry) => entry.status !== 'unchanged');
      if (wrote) {
        written.push({
          productId: product.productId,
          status: product.action === 'create' ? 'created' : 'updated',
        });
      }
      throw new AppStoreProductApplyError(product.productId, stage, written, error);
    }
  }
  return { appId: current.appId, products: done, manual: current.manual };
}

async function resolveVersion(
  port: AscIapPort,
  iapId: string,
  localizations: NonNullable<AppStoreProductWrite['localizations']>,
): Promise<string> {
  if (localizations.version === 'existing' && localizations.versionId !== undefined) {
    return localizations.versionId;
  }
  if (localizations.version === 'resolve') {
    // App Store Connect may already have provisioned the first version.
    const versions = await port.listVersions(iapId);
    if (versions.length > 1) {
      throw new Error(
        `in-app purchase ${iapId} has ${versions.length} versions; choose one in App Store Connect`,
      );
    }
    if (versions[0] !== undefined) {
      return versions[0].id;
    }
  }
  return port.createVersion(iapId);
}

/** One line per product for the terminal, then the manual steps. */
export function formatAppStoreProductPlan(plan: AppStoreProductPlan): string {
  const lines = [
    `App Store Connect app ${plan.appId} (${plan.bundleId}, catalog target ${plan.catalogTarget})`,
  ];
  for (const product of plan.products) {
    const flags = [
      product.state,
      product.livePriceChange ? 'PRICE CHANGE ON APPROVED PRODUCT' : undefined,
    ].filter((flag) => flag !== undefined);
    lines.push(`  ${product.action.padEnd(9)} ${product.productId} (${product.logicalId})${
      product.changes.length === 0 ? '' : `: ${product.changes.join(', ')}`}${
      flags.length === 0 ? '' : ` [${flags.join('; ')}]`}`);
    for (const change of product.priceChanges) {
      lines.push(
        `            price ${change.territory}: ${change.from ?? '-'} -> ${change.to ?? '-'}`,
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
    lines.push(
      `  remote    ${productId}: only on App Store Connect; not in the catalog (never deleted)`,
    );
  }
  for (const step of plan.manual) {
    lines.push(`  manual    ${step}`);
  }
  return lines.join('\n');
}

function readScreenshot(
  listingsDirectory: string,
  relative: string,
  label: string,
): { file: string; path: string; md5: string } {
  const file = path.resolve(listingsDirectory, relative);
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`${label}: review screenshot ${file} is missing.`);
  }
  if (!/\.(?:png|jpe?g)$/iu.test(file)) {
    throw new Error(`${label}: review screenshot ${file} must be a PNG or JPEG file.`);
  }
  // A symbolic link must not reach outside the game.
  const real = path.relative(realpathSync(listingsDirectory), realpathSync(file));
  if (real.startsWith('..') || path.isAbsolute(real)) {
    throw new Error(
      `${label}: review screenshot ${relative} resolves outside the listing file's directory.`,
    );
  }
  return { file, path: relative, md5: md5File(file) };
}

function md5File(file: string): string {
  return createHash('md5').update(readFileSync(file)).digest('hex');
}
