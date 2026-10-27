import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { planNativeDeployment } from './deploy-planning.js';
import { readStoreCredential } from './native-deploy-run.js';
import type { PlayProductCatalogPort } from './play-product-port.js';
import {
  readStoreProductPlanFile,
  readStoreProductSources,
  StoreProductPlanStaleError,
  writeStoreProductPlan,
} from './store-products.js';
import {
  applyPlayProductPlan,
  planPlayProducts,
  type PlayProductApplyResult,
  type PlayProductPlan,
} from './store-products-play.js';

/**
 * `mpgd store products plan|apply`: the game's deployment profile names the
 * app and the store credential (the same ones `deploy submit` uses), the
 * game's catalog and store listing file name the products.
 */

export type StoreProductStore = 'google-play';

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
  readonly plan: PlayProductPlan;
}

export type PlayPortFactory = (serviceAccountFile: string) => Promise<PlayProductCatalogPort>;

export async function planStoreProducts(
  options: StoreProductPlanOptions,
  environment: NodeJS.ProcessEnv = process.env,
  createPort: PlayPortFactory = loadPlayProductCatalog,
): Promise<StoreProductPlanFile> {
  if (options.store !== 'google-play') {
    throw new Error('--store must be google-play.');
  }
  const gameRoot = path.resolve(options.game);
  const deployment = planNativeDeployment({
    game: gameRoot,
    profile: options.profile,
    targets: ['android'],
  });
  const android = deployment.targets.find((entry) => entry.target === 'android');
  if (android === undefined) {
    throw new Error(`Deployment profile ${options.profile} has no Android target.`);
  }
  const sources = readStoreProductSources({
    gameRoot,
    ...(options.catalogFile === undefined ? {} : { catalogFile: options.catalogFile }),
    ...(options.listingsFile === undefined ? {} : { listingsFile: options.listingsFile }),
  });
  const credential = readStoreCredential(deployment, 'android', environment);
  if (credential.target !== 'android') {
    throw new Error('Google Play product sync needs the Android submission credential.');
  }
  const port = await createPort(credential.serviceAccountFile);
  const plan = await planPlayProducts(
    {
      packageName: android.appId,
      catalog: sources.catalog,
      listings: sources.listings,
      ...(options.catalogTarget === undefined ? {} : { catalogTarget: options.catalogTarget }),
      ...(options.keepLivePrices === true ? { keepLivePrices: true } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    port,
  );
  return {
    schemaVersion: 1,
    kind: 'mpgd-store-products-plan',
    gameRoot,
    profile: options.profile,
    catalogFile: sources.catalogFile,
    listingsFile: sources.listingsFile,
    plan,
  };
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
  createPort: PlayPortFactory = loadPlayProductCatalog,
): Promise<PlayProductApplyResult> {
  if (!options.approved) {
    throw new Error('Writing store products requires --approve.');
  }
  const saved = readSavedPlan(options.planFile);
  const gameRoot = options.game === undefined ? saved.gameRoot : path.resolve(options.game);
  const relocate = (file: string): string => options.game === undefined
    ? file
    : path.resolve(gameRoot, path.relative(saved.gameRoot, file));
  const current = await planStoreProducts(
    {
      game: gameRoot,
      profile: saved.profile,
      store: 'google-play',
      catalogFile: relocate(saved.catalogFile),
      listingsFile: relocate(saved.listingsFile),
      catalogTarget: saved.plan.catalogTarget,
      keepLivePrices: saved.plan.keepLivePrices,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    environment,
    createPort,
  );
  if (current.plan.packageName !== saved.plan.packageName) {
    throw new StoreProductPlanStaleError(
      `The deployment profile now names ${current.plan.packageName}, not ${saved.plan.packageName}.`,
    );
  }
  const credential = readStoreCredential(
    planNativeDeployment({ game: gameRoot, profile: saved.profile, targets: ['android'] }),
    'android',
    environment,
  );
  if (credential.target !== 'android') {
    throw new Error('Google Play product sync needs the Android submission credential.');
  }
  return applyPlayProductPlan({
    saved: saved.plan,
    current: current.plan,
    port: await createPort(credential.serviceAccountFile),
    approved: true,
    ...(options.confirmPriceChange === true ? { confirmPriceChange: true } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

function readSavedPlan(file: string): StoreProductPlanFile {
  const raw = readStoreProductPlanFile(file);
  const plan = raw.plan as Record<string, unknown> | undefined;
  if (raw.schemaVersion !== 1 || raw.kind !== 'mpgd-store-products-plan'
    || typeof raw.gameRoot !== 'string' || !path.isAbsolute(raw.gameRoot)
    || typeof raw.profile !== 'string' || typeof raw.catalogFile !== 'string'
    || typeof raw.listingsFile !== 'string' || typeof plan !== 'object' || plan === null
    || plan.schemaVersion !== 1 || plan.store !== 'google-play'
    || typeof plan.packageName !== 'string' || typeof plan.catalogTarget !== 'string'
    || typeof plan.keepLivePrices !== 'boolean' || !Array.isArray(plan.products)) {
    throw new Error('Saved store product plan is malformed.');
  }
  return raw as unknown as StoreProductPlanFile;
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
