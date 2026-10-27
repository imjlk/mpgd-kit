import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import type { AscIapPort } from './app-store-iap-port.js';
import { openAscIapSession, type AscCredential } from './app-store-iap-asc.js';
import type { PlayProductCatalogPort } from './play-product-port.js';
import {
  readStoreProductPlanFile,
  readStoreProductSources,
  StoreProductPlanStaleError,
  writeStoreProductPlan,
  type StoreProductSources,
} from './store-products.js';
import {
  applyAppStoreProductPlan,
  planAppStoreProducts,
  type AppStoreProductApplyResult,
  type AppStoreProductPlan,
} from './store-products-app-store.js';
import {
  applyPlayProductPlan,
  planPlayProducts,
  type PlayProductApplyResult,
  type PlayProductPlan,
} from './store-products-play.js';
import { relocateStoreSyncFile, resolveStoreSyncApp, type StoreSyncStore } from './store-sync.js';

/**
 * `mpgd store products plan|apply`: the game's deployment profile names the
 * app and the store credential (the same ones `deploy submit` uses), the
 * game's catalog and store listing file name the products.
 */

export type StoreProductStore = StoreSyncStore;

export interface StoreProductPlanOptions {
  readonly game: string;
  readonly profile: string;
  readonly store: StoreProductStore;
  readonly catalogFile?: string;
  readonly listingsFile?: string;
  readonly catalogTarget?: string;
  readonly keepLivePrices?: boolean;
  readonly signal?: AbortSignal;
}

/** The saved plan: the inputs apply re-reads, and the reviewed plan. */
export interface StoreProductPlanFile {
  readonly schemaVersion: 1;
  readonly kind: 'mpgd-store-products-plan';
  readonly gameRoot: string;
  readonly profile: string;
  readonly catalogFile: string;
  readonly listingsFile: string;
  readonly plan: PlayProductPlan | AppStoreProductPlan;
}

/** Store clients; the tests replace them with fakes. */
export interface StoreProductPorts {
  readonly googlePlay: (serviceAccountFile: string) => Promise<PlayProductCatalogPort>;
  readonly appStore: (
    credential: AscCredential,
    signal?: AbortSignal,
  ) => Promise<{ readonly port: AscIapPort; close(): void }>;
}

const defaultPorts: StoreProductPorts = {
  googlePlay: loadPlayProductCatalog,
  appStore: openAscIapSession,
};

type StoreSession =
  | {
      readonly store: 'google-play';
      readonly packageName: string;
      readonly port: PlayProductCatalogPort;
      readonly sources: StoreProductSources;
    }
  | {
      readonly store: 'app-store';
      readonly appId: string;
      readonly bundleId: string;
      readonly port: AscIapPort;
      readonly sources: StoreProductSources;
    };

export async function planStoreProducts(
  options: StoreProductPlanOptions,
  environment: NodeJS.ProcessEnv = process.env,
  ports: Partial<StoreProductPorts> = {},
): Promise<StoreProductPlanFile> {
  return withStoreSession(options, environment, ports, async (session) => ({
    schemaVersion: 1,
    kind: 'mpgd-store-products-plan',
    gameRoot: path.resolve(options.game),
    profile: options.profile,
    catalogFile: session.sources.catalogFile,
    listingsFile: session.sources.listingsFile,
    plan: await planWithSession(session, options),
  }));
}

export function saveStoreProductPlan(file: string, plan: StoreProductPlanFile): string {
  return writeStoreProductPlan(file, plan);
}

export interface StoreProductApplyOptions {
  readonly planFile: string;
  /** Current game directory, when the game moved since the plan. */
  readonly game?: string;
  readonly approved: boolean;
  readonly confirmPriceChange?: boolean;
  readonly signal?: AbortSignal;
}

export async function applyStoreProducts(
  options: StoreProductApplyOptions,
  environment: NodeJS.ProcessEnv = process.env,
  ports: Partial<StoreProductPorts> = {},
): Promise<PlayProductApplyResult | AppStoreProductApplyResult> {
  if (!options.approved) {
    throw new Error('Writing store products requires --approve.');
  }
  const saved = readSavedPlan(options.planFile);
  const gameRoot = options.game === undefined ? saved.gameRoot : path.resolve(options.game);
  const relocate = (file: string): string => relocateStoreSyncFile(
    saved.gameRoot,
    options.game === undefined ? undefined : gameRoot,
    file,
  );
  const planOptions: StoreProductPlanOptions = {
    game: gameRoot,
    profile: saved.profile,
    store: saved.plan.store,
    catalogFile: relocate(saved.catalogFile),
    listingsFile: relocate(saved.listingsFile),
    catalogTarget: saved.plan.catalogTarget,
    keepLivePrices: saved.plan.keepLivePrices,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return withStoreSession(planOptions, environment, ports, async (session) => {
    const current = await planWithSession(session, planOptions);
    if (session.store === 'google-play' && current.store === 'google-play'
      && saved.plan.store === 'google-play') {
      if (current.packageName !== saved.plan.packageName) {
        throw new StoreProductPlanStaleError(
          `The deployment profile now names ${current.packageName}, not ${saved.plan.packageName}.`,
        );
      }
      return applyPlayProductPlan({
        saved: saved.plan,
        current,
        port: session.port,
        approved: true,
        ...(options.confirmPriceChange === true ? { confirmPriceChange: true } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    if (session.store === 'app-store' && current.store === 'app-store' && saved.plan.store === 'app-store') {
      if (current.appId !== saved.plan.appId || current.bundleId !== saved.plan.bundleId) {
        throw new StoreProductPlanStaleError(
          `The deployment profile now names app ${current.appId} (${current.bundleId}), not ${
            saved.plan.appId} (${saved.plan.bundleId}).`,
        );
      }
      return applyAppStoreProductPlan({
        saved: saved.plan,
        current,
        port: session.port,
        approved: true,
        ...(options.confirmPriceChange === true ? { confirmPriceChange: true } : {}),
      });
    }
    throw new Error('Saved store product plan is malformed.');
  });
}

async function withStoreSession<T>(
  options: StoreProductPlanOptions,
  environment: NodeJS.ProcessEnv,
  overrides: Partial<StoreProductPorts>,
  action: (session: StoreSession) => Promise<T>,
): Promise<T> {
  const ports = { ...defaultPorts, ...overrides };
  const app = resolveStoreSyncApp(options, environment);
  const sources = readStoreProductSources({
    gameRoot: path.resolve(options.game),
    ...(options.catalogFile === undefined ? {} : { catalogFile: options.catalogFile }),
    ...(options.listingsFile === undefined ? {} : { listingsFile: options.listingsFile }),
  });
  if (app.store === 'google-play') {
    const port = await ports.googlePlay(app.serviceAccountFile);
    return action({ store: 'google-play', packageName: app.packageName, port, sources });
  }
  const session = await ports.appStore(app.credential, options.signal);
  try {
    return await action({
      store: 'app-store',
      appId: app.appId,
      bundleId: app.bundleId,
      port: session.port,
      sources,
    });
  } finally {
    session.close();
  }
}

async function planWithSession(
  session: StoreSession,
  options: StoreProductPlanOptions,
): Promise<PlayProductPlan | AppStoreProductPlan> {
  const common = {
    catalog: session.sources.catalog,
    listings: session.sources.listings,
    ...(options.catalogTarget === undefined ? {} : { catalogTarget: options.catalogTarget }),
    ...(options.keepLivePrices === true ? { keepLivePrices: true } : {}),
  };
  if (session.store === 'google-play') {
    return planPlayProducts(
      {
        packageName: session.packageName,
        ...common,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      session.port,
    );
  }
  return planAppStoreProducts(
    {
      appId: session.appId,
      bundleId: session.bundleId,
      listingsDirectory: path.dirname(session.sources.listingsFile),
      ...common,
    },
    session.port,
  );
}

function readSavedPlan(file: string): StoreProductPlanFile {
  const raw = readStoreProductPlanFile(file);
  const plan = raw.plan as Record<string, unknown> | undefined;
  const storeFields = typeof plan === 'object' && plan !== null && (
    (plan.store === 'google-play' && typeof plan.packageName === 'string')
    || (plan.store === 'app-store' && typeof plan.appId === 'string' && typeof plan.bundleId === 'string')
  );
  if (raw.schemaVersion !== 1 || raw.kind !== 'mpgd-store-products-plan'
    || typeof raw.gameRoot !== 'string' || !path.isAbsolute(raw.gameRoot)
    || typeof raw.profile !== 'string' || typeof raw.catalogFile !== 'string'
    || typeof raw.listingsFile !== 'string' || typeof plan !== 'object' || plan === null
    || plan.schemaVersion !== 1 || !storeFields
    || typeof plan.catalogTarget !== 'string'
    || typeof plan.keepLivePrices !== 'boolean' || !Array.isArray(plan.products)
    || !plan.products.every(isSavedProduct)) {
    throw new Error('Saved store product plan is malformed.');
  }
  return raw as unknown as StoreProductPlanFile;
}

function isSavedProduct(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const product = value as Record<string, unknown>;
  return typeof product.productId === 'string' && typeof product.action === 'string'
    && (product.remoteSha256 === null || typeof product.remoteSha256 === 'string')
    && typeof product.desiredSha256 === 'string';
}

async function loadPlayProductCatalog(serviceAccountFile: string): Promise<PlayProductCatalogPort> {
  if (!existsSync(serviceAccountFile) || !statSync(serviceAccountFile).isFile()) {
    throw new Error('Google Play service account file is missing.');
  }
  const { createServiceAccountProductCatalog } = await import(
    new URL('./play-sdk-adapter.js', import.meta.url).href
  ) as { createServiceAccountProductCatalog: (file: string) => PlayProductCatalogPort };
  return createServiceAccountProductCatalog(serviceAccountFile);
}
