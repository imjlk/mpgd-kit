import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import type { PlayStoreListingPort } from './play-listing-port.js';
import { readStorePresenceSource, type StorePresenceSource } from './store-presence.js';
import {
  applyPlayPresence,
  planPlayPresence,
  type PlayPresenceApplyResult,
  type PlayPresencePlan,
} from './store-presence-play.js';
import {
  assertStoreSyncStore,
  readStorePlanFile,
  relocateStoreSyncFile,
  resolveStoreSyncApp,
  writeStorePlanFile,
  type StoreSyncApp,
  type StoreSyncStore,
} from './store-sync.js';

/**
 * `mpgd store presence plan|apply`: the deployment profile names the app and
 * the store credential (the same ones `deploy submit` uses); the game's
 * `mpgd.store-presence.json` names the store page text and graphics.
 */

export type StorePresenceStore = StoreSyncStore;

export interface StorePresencePlanOptions {
  readonly game: string;
  readonly profile: string;
  readonly store: StorePresenceStore;
  readonly presenceFile?: string;
  readonly signal?: AbortSignal;
}

/** The saved plan: the inputs apply re-reads, and the reviewed plan. */
export interface StorePresencePlanFile {
  readonly schemaVersion: 1;
  readonly kind: 'mpgd-store-presence-plan';
  readonly gameRoot: string;
  readonly profile: string;
  readonly presenceFile: string;
  readonly plan: PlayPresencePlan;
}

/** Store clients; the tests replace them with fakes. */
export interface StorePresencePorts {
  readonly googlePlay: (serviceAccountFile: string) => Promise<PlayStoreListingPort>;
}

const defaultPorts: StorePresencePorts = {
  googlePlay: loadPlayStoreListing,
};

export async function planStorePresence(
  options: StorePresencePlanOptions,
  environment: NodeJS.ProcessEnv = process.env,
  ports: Partial<StorePresencePorts> = {},
): Promise<StorePresencePlanFile> {
  const { app, source } = resolveInputs(options, environment);
  const plan = await withPlayPort(app, ports, (packageName, port) =>
    planPlayPresence(
      {
        packageName,
        presence: source.presence,
        directory: source.directory,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      port,
    ),
  );
  return {
    schemaVersion: 1,
    kind: 'mpgd-store-presence-plan',
    gameRoot: path.resolve(options.game),
    profile: options.profile,
    presenceFile: source.file,
    plan,
  };
}

export function saveStorePresencePlan(file: string, plan: StorePresencePlanFile): string {
  return writeStorePlanFile(file, plan);
}

export interface StorePresenceApplyOptions {
  readonly planFile: string;
  /** Current game directory, when the game moved since the plan. */
  readonly game?: string;
  readonly approved: boolean;
  /** Allow a complete image set to remove images the store holds. */
  readonly confirmImageRemoval?: boolean;
  /** Google Play: commit with `changesNotSentForReview` (send for review in Play Console). */
  readonly changesNotSentForReview?: boolean;
  readonly signal?: AbortSignal;
}

export async function applyStorePresence(
  options: StorePresenceApplyOptions,
  environment: NodeJS.ProcessEnv = process.env,
  ports: Partial<StorePresencePorts> = {},
): Promise<PlayPresenceApplyResult> {
  if (!options.approved) {
    throw new Error('Writing the store listing requires --approve.');
  }
  const saved = readSavedPlan(options.planFile);
  const gameRoot = options.game === undefined ? saved.gameRoot : path.resolve(options.game);
  const planOptions: StorePresencePlanOptions = {
    game: gameRoot,
    profile: saved.profile,
    store: saved.plan.store,
    presenceFile: relocateStoreSyncFile(
      saved.gameRoot,
      options.game === undefined ? undefined : gameRoot,
      saved.presenceFile,
    ),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const { app, source } = resolveInputs(planOptions, environment);
  return withPlayPort(app, ports, (packageName, port) =>
    applyPlayPresence({
      saved: saved.plan,
      plan: {
        packageName,
        presence: source.presence,
        directory: source.directory,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      port,
      approved: true,
      ...(options.confirmImageRemoval === true ? { confirmImageRemoval: true } : {}),
      ...(options.changesNotSentForReview === true ? { changesNotSentForReview: true } : {}),
    }),
  );
}

function resolveInputs(
  options: StorePresencePlanOptions,
  environment: NodeJS.ProcessEnv,
): { readonly app: StoreSyncApp; readonly source: StorePresenceSource } {
  assertStoreSyncStore(options.store);
  if (options.store === 'app-store') {
    throw new Error(
      'mpgd store presence supports --store google-play; the App Store sync is not available yet.',
    );
  }
  // The game file first: a malformed file reports its own error without a credential.
  const source = readStorePresenceSource({
    gameRoot: options.game,
    ...(options.presenceFile === undefined ? {} : { presenceFile: options.presenceFile }),
  });
  const app = resolveStoreSyncApp(options, environment);
  return { app, source };
}

async function withPlayPort<T>(
  app: StoreSyncApp,
  overrides: Partial<StorePresencePorts>,
  action: (packageName: string, port: PlayStoreListingPort) => Promise<T>,
): Promise<T> {
  if (app.store !== 'google-play') {
    throw new Error('mpgd store presence supports --store google-play only.');
  }
  const ports = { ...defaultPorts, ...overrides };
  return action(app.packageName, await ports.googlePlay(app.serviceAccountFile));
}

function readSavedPlan(file: string): StorePresencePlanFile {
  const raw = readStorePlanFile(file, 'store presence plan');
  const plan = raw.plan as Record<string, unknown> | undefined;
  if (raw.schemaVersion !== 1 || raw.kind !== 'mpgd-store-presence-plan'
    || typeof raw.gameRoot !== 'string' || !path.isAbsolute(raw.gameRoot)
    || typeof raw.profile !== 'string' || typeof raw.presenceFile !== 'string'
    || typeof plan !== 'object' || plan === null || plan.schemaVersion !== 1
    || plan.store !== 'google-play' || typeof plan.packageName !== 'string'
    || typeof plan.remoteSha256 !== 'string' || typeof plan.desiredSha256 !== 'string'
    || typeof plan.changed !== 'boolean' || typeof plan.imageRemovals !== 'number'
    || !Array.isArray(plan.languages)) {
    throw new Error('Saved store presence plan is malformed.');
  }
  return raw as unknown as StorePresencePlanFile;
}

async function loadPlayStoreListing(serviceAccountFile: string): Promise<PlayStoreListingPort> {
  if (!existsSync(serviceAccountFile) || !statSync(serviceAccountFile).isFile()) {
    throw new Error('Google Play service account file is missing.');
  }
  const { createServiceAccountStoreListing } = await import(
    new URL('./play-sdk-adapter.js', import.meta.url).href
  ) as { createServiceAccountStoreListing: (file: string) => PlayStoreListingPort };
  return createServiceAccountStoreListing(serviceAccountFile);
}
