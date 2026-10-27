import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { openAscStorePresenceSession } from './app-store-presence-asc.js';
import type { AscStorePresencePort } from './app-store-presence-port.js';
import type { AscCredential } from './asc-session.js';
import type { PlayStoreListingPort } from './play-listing-port.js';
import {
  readStorePresenceSource,
  storePresencePlanCommand,
  type StorePresenceSource,
} from './store-presence.js';
import {
  applyAppStorePresence,
  planAppStorePresence,
  type AppStorePresenceApplyResult,
  type AppStorePresencePlan,
} from './store-presence-app-store.js';
import {
  applyPlayPresence,
  planPlayPresence,
  type PlayPresenceApplyResult,
  type PlayPresencePlan,
} from './store-presence-play.js';
import {
  readStorePlanFile,
  relocateStoreSyncFile,
  resolveStoreSyncApp,
  StorePlanStaleError,
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
  readonly plan: PlayPresencePlan | AppStorePresencePlan;
}

/** Store clients; the tests replace them with fakes. */
export interface StorePresencePorts {
  readonly googlePlay: (serviceAccountFile: string) => Promise<PlayStoreListingPort>;
  readonly appStore: (
    credential: AscCredential,
    signal?: AbortSignal,
  ) => Promise<{ readonly port: AscStorePresencePort; close(): void }>;
}

const defaultPorts: StorePresencePorts = {
  googlePlay: loadPlayStoreListing,
  appStore: openAscStorePresenceSession,
};

type StoreSession =
  | { readonly store: 'google-play'; readonly packageName: string; readonly port: PlayStoreListingPort }
  | {
      readonly store: 'app-store';
      readonly appId: string;
      readonly bundleId: string;
      readonly port: AscStorePresencePort;
    };

export async function planStorePresence(
  options: StorePresencePlanOptions,
  environment: NodeJS.ProcessEnv = process.env,
  ports: Partial<StorePresencePorts> = {},
): Promise<StorePresencePlanFile> {
  const { app, source } = resolveInputs(options, environment);
  const plan = await withSession<PlayPresencePlan | AppStorePresencePlan>(
    app,
    ports,
    options.signal,
    (session) => {
      if (session.store === 'google-play') {
        return planPlayPresence(
          {
            packageName: session.packageName,
            presence: source.presence,
            directory: source.directory,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
          session.port,
        );
      }
      return planAppStorePresence(
        {
          appId: session.appId,
          bundleId: session.bundleId,
          presence: source.presence,
          directory: source.directory,
        },
        session.port,
      );
    },
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
): Promise<PlayPresenceApplyResult | AppStorePresenceApplyResult> {
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
  const removal = options.confirmImageRemoval === true ? { confirmImageRemoval: true } : {};
  return withSession<PlayPresenceApplyResult | AppStorePresenceApplyResult>(
    app,
    ports,
    options.signal,
    (session) => {
      if (session.store === 'google-play' && saved.plan.store === 'google-play') {
        return applyPlayPresence({
          saved: saved.plan,
          plan: {
            packageName: session.packageName,
            presence: source.presence,
            directory: source.directory,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
          port: session.port,
          approved: true,
          ...removal,
          ...(options.changesNotSentForReview === true ? { changesNotSentForReview: true } : {}),
        });
      }
      if (session.store === 'app-store' && saved.plan.store === 'app-store') {
        return applyAppStorePresence({
          saved: saved.plan,
          plan: {
            appId: session.appId,
            bundleId: session.bundleId,
            presence: source.presence,
            directory: source.directory,
          },
          port: session.port,
          approved: true,
          ...removal,
        });
      }
      throw new StorePlanStaleError(
        'The saved plan is for another store.',
        storePresencePlanCommand,
      );
    },
  );
}

function resolveInputs(
  options: StorePresencePlanOptions,
  environment: NodeJS.ProcessEnv,
): { readonly app: StoreSyncApp; readonly source: StorePresenceSource } {
  const app = resolveStoreSyncApp(options, environment);
  const source = readStorePresenceSource({
    gameRoot: options.game,
    ...(options.presenceFile === undefined ? {} : { presenceFile: options.presenceFile }),
  });
  return { app, source };
}

/** One store session per command. */
async function withSession<T>(
  app: StoreSyncApp,
  overrides: Partial<StorePresencePorts>,
  signal: AbortSignal | undefined,
  action: (session: StoreSession) => Promise<T>,
): Promise<T> {
  const ports = { ...defaultPorts, ...overrides };
  if (app.store === 'google-play') {
    const port = await ports.googlePlay(app.serviceAccountFile);
    return action({ store: 'google-play', packageName: app.packageName, port });
  }
  const session = await ports.appStore(app.credential, signal);
  try {
    return await action({
      store: 'app-store',
      appId: app.appId,
      bundleId: app.bundleId,
      port: session.port,
    });
  } finally {
    session.close();
  }
}

function readSavedPlan(file: string): StorePresencePlanFile {
  const raw = readStorePlanFile(file, 'store presence plan');
  const plan = raw.plan as Record<string, unknown> | undefined;
  const storeFields = typeof plan === 'object' && plan !== null && (
    (plan.store === 'google-play' && typeof plan.packageName === 'string' && Array.isArray(plan.languages))
    || (plan.store === 'app-store' && typeof plan.appId === 'string' && typeof plan.bundleId === 'string'
      && Array.isArray(plan.locales))
  );
  if (raw.schemaVersion !== 1 || raw.kind !== 'mpgd-store-presence-plan'
    || typeof raw.gameRoot !== 'string' || !path.isAbsolute(raw.gameRoot)
    || typeof raw.profile !== 'string' || typeof raw.presenceFile !== 'string'
    || typeof plan !== 'object' || plan === null || plan.schemaVersion !== 1 || !storeFields
    || typeof plan.remoteSha256 !== 'string' || typeof plan.desiredSha256 !== 'string'
    || typeof plan.changed !== 'boolean' || typeof plan.imageRemovals !== 'number') {
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
