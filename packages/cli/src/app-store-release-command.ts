import { existsSync } from 'node:fs';
import path from 'node:path';

import type { StorePresence } from '@mpgd/catalog';

import { openAscReleaseSession, type AscReleaseSession } from './app-store-release-asc.js';
import type { AscReleaseType } from './app-store-release-port.js';
import {
  applyAppStoreRelease,
  appStoreReleasePlanCommand,
  changeAppStorePhasedRelease,
  planAppStoreRelease,
  publishAppStoreVersion,
  readAppStoreReleaseStatus,
  type AppStoreReleaseApplyResult,
  type AppStoreReleaseDemoAccount,
  type AppStoreReleasePlan,
  type AppStoreReleasePlanInput,
  type AppStoreReleaseRequest,
  type AppStoreReleaseStatus,
  type PhasedReleaseAction,
} from './app-store-release.js';
import type { AscCredential } from './asc-session.js';
import { readIosDeviceFamily } from './native-shell-store-policy.js';
import { readNativeReleaseStatus } from './release-state.js';
import { readStorePresenceSource } from './store-presence.js';
import {
  readJsonFile,
  readStorePlanFile,
  relocateStoreSyncFile,
  resolveStoreSyncApp,
  StorePlanStaleError,
  writeStorePlanFile,
} from './store-sync.js';

/**
 * `mpgd store release plan|apply|status|publish|phased`: the deployment
 * profile names the App Store Connect app and the asc credential (the same
 * ones `deploy submit` uses); `mpgd.store-presence.json` names What's New,
 * the copyright line and App Review information; `mpgd.targets.json` says
 * whether the app runs on iPad; the release ledger names the build
 * `deploy run` recorded.
 */

export interface AppStoreReleaseCommandPorts {
  readonly appStore: (
    credential: AscCredential,
    options: { readonly signal?: AbortSignal; readonly secretValues?: readonly string[] },
  ) => Promise<AscReleaseSession>;
  readonly readReleaseStatus: typeof readNativeReleaseStatus;
  readonly now: () => Date;
}

const defaultPorts: AppStoreReleaseCommandPorts = {
  appStore: openAscReleaseSession,
  readReleaseStatus: readNativeReleaseStatus,
  now: () => new Date(),
};

export type ReleaseTypeOption = 'manual' | 'after-approval' | 'scheduled';

export interface AppStoreReleasePlanOptions {
  readonly game: string;
  readonly profile: string;
  readonly presenceFile?: string;
  /** The marketing version; optional with `release`, whose recorded build names it. */
  readonly version?: string;
  readonly buildNumber?: string;
  /** Release ledger game ID and release ID of the build `deploy run` recorded. */
  readonly gameId?: string;
  readonly release?: string;
  readonly releaseType?: ReleaseTypeOption;
  readonly releaseDate?: string;
  readonly phasedRelease?: boolean;
  readonly skipIaps?: readonly string[];
  readonly rotateDemoPassword?: boolean;
  readonly signal?: AbortSignal;
}

/** The saved plan: the inputs apply re-reads, and the reviewed plan. No secret is saved. */
export interface AppStoreReleasePlanFile {
  readonly schemaVersion: 1;
  readonly kind: 'mpgd-store-release-plan';
  readonly gameRoot: string;
  readonly profile: string;
  readonly presenceFile: string;
  readonly request: AppStoreReleaseRequest;
  readonly plan: AppStoreReleasePlan;
}

const releaseTypes: Readonly<Record<ReleaseTypeOption, AscReleaseType>> = {
  manual: 'MANUAL',
  'after-approval': 'AFTER_APPROVAL',
  scheduled: 'SCHEDULED',
};

export async function planAppStoreReleaseCommand(
  options: AppStoreReleasePlanOptions,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AppStoreReleaseCommandPorts> = {},
): Promise<AppStoreReleasePlanFile> {
  const ports = { ...defaultPorts, ...overrides };
  const gameRoot = path.resolve(options.game);
  const source = readPresence(gameRoot, options.presenceFile);
  const request = await resolveRequest(options, gameRoot, environment, ports);
  const plan = await withSession(
    { game: gameRoot, profile: options.profile },
    source.presence,
    environment,
    ports,
    options.signal,
    (session, app, demoAccount) =>
      planAppStoreRelease(
        {
          appId: app.appId,
          bundleId: app.bundleId,
          presence: source.presence,
          request,
          ...(demoAccount === undefined ? {} : { demoAccount }),
          now: ports.now,
        },
        session,
      ),
  );
  return {
    schemaVersion: 1,
    kind: 'mpgd-store-release-plan',
    gameRoot,
    profile: options.profile,
    presenceFile: source.file,
    request,
    plan,
  };
}

export function saveAppStoreReleasePlan(file: string, plan: AppStoreReleasePlanFile): string {
  return writeStorePlanFile(file, plan);
}

export interface AppStoreReleaseApplyOptions {
  readonly planFile: string;
  /** Current game directory, when the game moved since the plan. */
  readonly game?: string;
  readonly approved: boolean;
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}

export async function applyAppStoreReleaseCommand(
  options: AppStoreReleaseApplyOptions,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AppStoreReleaseCommandPorts> = {},
): Promise<AppStoreReleaseApplyResult> {
  if (!options.approved && options.dryRun !== true) {
    throw new Error(
      'Submitting the App Store release requires --approve (or --dry-run to print it).',
    );
  }
  const ports = { ...defaultPorts, ...overrides };
  const saved = readSavedPlan(options.planFile);
  const gameRoot = options.game === undefined ? saved.gameRoot : path.resolve(options.game);
  const presenceFile = relocateStoreSyncFile(
    saved.gameRoot,
    options.game === undefined ? undefined : gameRoot,
    saved.presenceFile,
  );
  const source = readPresence(gameRoot, presenceFile);
  // The universal flag comes from the game again: a changed target is a new plan.
  const request = { ...saved.request, universal: readUniversal(gameRoot) };
  return withSession(
    { game: gameRoot, profile: saved.profile },
    source.presence,
    environment,
    ports,
    options.signal,
    (session, app, demoAccount) => applyAppStoreRelease({
      saved: saved.plan,
      plan: {
        appId: app.appId,
        bundleId: app.bundleId,
        presence: source.presence,
        request,
        ...(demoAccount === undefined ? {} : { demoAccount }),
        now: ports.now,
      } satisfies AppStoreReleasePlanInput,
      ports: session,
      approved: options.approved,
      ...(options.dryRun === true ? { dryRun: true } : {}),
    }),
  );
}

export interface AppStoreReleaseVersionOptions {
  readonly game: string;
  readonly profile: string;
  readonly version?: string;
  readonly signal?: AbortSignal;
}

export async function readAppStoreReleaseStatusCommand(
  options: AppStoreReleaseVersionOptions,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AppStoreReleaseCommandPorts> = {},
): Promise<AppStoreReleaseStatus> {
  const ports = { ...defaultPorts, ...overrides };
  return withSession(
    { game: path.resolve(options.game), profile: options.profile },
    undefined,
    environment,
    ports,
    options.signal,
    (session, app) =>
      readAppStoreReleaseStatus(
        {
          appId: app.appId,
          bundleId: app.bundleId,
          ...(options.version === undefined ? {} : { marketingVersion: options.version }),
        },
        session.release,
      ),
  );
}

export async function publishAppStoreVersionCommand(
  options: AppStoreReleaseVersionOptions & { readonly approved: boolean },
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AppStoreReleaseCommandPorts> = {},
): Promise<Awaited<ReturnType<typeof publishAppStoreVersion>>> {
  const marketingVersion = requireVersion(options.version);
  if (!options.approved) {
    throw new Error('Releasing the App Store version requires --approve.');
  }
  const ports = { ...defaultPorts, ...overrides };
  return withSession(
    { game: path.resolve(options.game), profile: options.profile },
    undefined,
    environment,
    ports,
    options.signal,
    (session, app) =>
      publishAppStoreVersion(
        {
          appId: app.appId,
          bundleId: app.bundleId,
          marketingVersion,
          approved: true,
        },
        session.release,
      ),
  );
}

export async function changeAppStorePhasedReleaseCommand(
  options: AppStoreReleaseVersionOptions & { readonly action: string; readonly approved: boolean },
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<AppStoreReleaseCommandPorts> = {},
): Promise<Awaited<ReturnType<typeof changeAppStorePhasedRelease>>> {
  const marketingVersion = requireVersion(options.version);
  if (!['pause', 'resume', 'complete'].includes(options.action)) {
    throw new Error('--action must be pause, resume or complete.');
  }
  if (!options.approved) {
    throw new Error('Changing the phased release requires --approve.');
  }
  const ports = { ...defaultPorts, ...overrides };
  return withSession(
    { game: path.resolve(options.game), profile: options.profile },
    undefined,
    environment,
    ports,
    options.signal,
    (session, app) =>
      changeAppStorePhasedRelease(
        {
          appId: app.appId,
          bundleId: app.bundleId,
          marketingVersion,
          action: options.action as PhasedReleaseAction,
          approved: true,
        },
        session.release,
      ),
  );
}

function requireVersion(version: string | undefined): string {
  if (version === undefined || version === '') {
    throw new Error('--marketing-version is required.');
  }
  return version;
}

function readPresence(gameRoot: string, presenceFile: string | undefined): {
  readonly file: string;
  readonly presence: StorePresence;
} {
  const source = readStorePresenceSource({
    gameRoot,
    ...(presenceFile === undefined ? {} : { presenceFile }),
  });
  if (source.presence.appStore === undefined) {
    throw new Error(`${source.file} has no appStore section.`);
  }
  return source;
}

/**
 * Whether the app runs on iPad: `mpgd.targets.json` ios `metadata.iosDeviceFamily`.
 * Unset counts as universal, the device family of the Capacitor iOS template.
 */
function readUniversal(gameRoot: string): boolean {
  const file = path.join(gameRoot, 'mpgd.targets.json');
  if (!existsSync(file)) {
    return true;
  }
  const targets = readJsonFile(file);
  const ios = isRecord(targets) && isRecord(targets.targets) ? targets.targets.ios : undefined;
  return readIosDeviceFamily(isRecord(ios) ? ios.metadata : undefined) !== 'iphone';
}

async function resolveRequest(
  options: AppStoreReleasePlanOptions,
  gameRoot: string,
  environment: NodeJS.ProcessEnv,
  ports: AppStoreReleaseCommandPorts,
): Promise<AppStoreReleaseRequest> {
  let marketingVersion = options.version;
  let buildNumber = options.buildNumber;
  let recordedBuildId: string | undefined;
  if ((options.gameId === undefined) !== (options.release === undefined)) {
    throw new Error('--game-id and --release go together.');
  }
  if (options.gameId !== undefined && options.release !== undefined) {
    const status = await ports.readReleaseStatus({
      gameRoot,
      gameId: options.gameId,
      releaseKey: options.release,
      environment,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const record = status.builds.ios;
    if (record === undefined) {
      throw new Error(`Release ${options.release} has no recorded iOS build.`);
    }
    const recordedVersion = record.platformVersion.marketingVersion;
    const recordedBuild = record.platformVersion.buildNumber;
    if (typeof recordedVersion !== 'string' || (typeof recordedBuild !== 'string' && typeof recordedBuild !== 'number')) {
      throw new Error(
        `Release ${options.release} recorded no iOS marketing version and build number.`,
      );
    }
    if (marketingVersion !== undefined && marketingVersion !== recordedVersion) {
      throw new Error(
        `--marketing-version ${marketingVersion} differs from ${recordedVersion} that release ${options.release} built.`,
      );
    }
    if (buildNumber !== undefined && buildNumber !== String(recordedBuild)) {
      throw new Error(
        `--build-number ${buildNumber} differs from ${String(recordedBuild)} that release ${options.release} built.`,
      );
    }
    marketingVersion = recordedVersion;
    buildNumber = String(recordedBuild);
    recordedBuildId = status.submissions.ios?.remoteBuildId;
  }
  if (marketingVersion === undefined) {
    throw new Error(
      'Name the version with --marketing-version, or the recorded build with --game-id and --release.',
    );
  }
  const releaseType = options.releaseType ?? 'manual';
  if (!(releaseType in releaseTypes)) {
    throw new Error('--release-type must be manual, after-approval or scheduled.');
  }
  return {
    marketingVersion,
    ...(buildNumber === undefined ? {} : { buildNumber }),
    ...(recordedBuildId === undefined ? {} : { recordedBuildId }),
    universal: readUniversal(gameRoot),
    releaseType: releaseTypes[releaseType],
    ...(options.releaseDate === undefined ? {} : { earliestReleaseDate: options.releaseDate }),
    phasedRelease: options.phasedRelease === true,
    skipIaps: [...new Set(options.skipIaps ?? [])].sort(),
    rotateDemoPassword: options.rotateDemoPassword === true,
  };
}

/** The demo account values from the variables the presence file names. */
function readDemoAccount(
  presence: StorePresence | undefined,
  environment: NodeJS.ProcessEnv,
): AppStoreReleaseDemoAccount | undefined {
  const names = presence?.appStore?.review?.demoAccount;
  if (names === undefined) {
    return undefined;
  }
  const read = (name: string): string => {
    const value = environment[name];
    if (value === undefined || value.trim() === '') {
      throw new Error(
        `appStore.review.demoAccount names ${name}, which is not set: export the demo account there before planning.`,
      );
    }
    // asc trims the flag values it sends, so a value with surrounding spaces would
    // reach App Review as another password: refuse it instead of changing it.
    if (value.trim() !== value) {
      throw new Error(
        `${name} starts or ends with whitespace, which asc would strip before sending it to App Store Connect.`,
      );
    }
    return value;
  };
  const account = { name: read(names.nameEnv), password: read(names.passwordEnv) };
  if ([...account.password].length > 100) {
    throw new Error(
      `${names.passwordEnv} is longer than the 100 characters App Store Connect takes.`,
    );
  }
  return account;
}

/** One asc session per command, with the demo account redacted from its output. */
async function withSession<T>(
  options: { readonly game: string; readonly profile: string },
  presence: StorePresence | undefined,
  environment: NodeJS.ProcessEnv,
  ports: AppStoreReleaseCommandPorts,
  signal: AbortSignal | undefined,
  action: (
    session: AscReleaseSession,
    app: { readonly appId: string; readonly bundleId: string },
    demoAccount: AppStoreReleaseDemoAccount | undefined,
  ) => Promise<T>,
): Promise<T> {
  const demoAccount = readDemoAccount(presence, environment);
  const app = resolveStoreSyncApp({ ...options, store: 'app-store' }, environment);
  if (app.store !== 'app-store') {
    throw new Error('The deployment profile has no App Store app.');
  }
  const session = await ports.appStore(app.credential, {
    ...(signal === undefined ? {} : { signal }),
    secretValues: demoAccount === undefined ? [] : [demoAccount.password, demoAccount.name],
  });
  try {
    return await action(session, { appId: app.appId, bundleId: app.bundleId }, demoAccount);
  } finally {
    session.close();
  }
}

function readSavedPlan(file: string): AppStoreReleasePlanFile {
  const raw = readStorePlanFile(file, 'store release plan');
  const plan = raw.plan as Record<string, unknown> | undefined;
  const request = raw.request as Record<string, unknown> | undefined;
  if (raw.schemaVersion !== 1 || raw.kind !== 'mpgd-store-release-plan'
    || typeof raw.gameRoot !== 'string' || !path.isAbsolute(raw.gameRoot)
    || typeof raw.profile !== 'string' || typeof raw.presenceFile !== 'string'
    || typeof request !== 'object' || request === null || typeof request.marketingVersion !== 'string'
    || typeof request.releaseType !== 'string' || !Array.isArray(request.skipIaps)
    || typeof plan !== 'object' || plan === null || plan.schemaVersion !== 1 || plan.store !== 'app-store'
    || typeof plan.appId !== 'string' || typeof plan.bundleId !== 'string'
    || typeof plan.remoteSha256 !== 'string' || typeof plan.desiredSha256 !== 'string'
    || !Array.isArray(plan.operations) || !Array.isArray(plan.blockers)) {
    throw new Error('Saved store release plan is malformed.');
  }
  if (plan.marketingVersion !== request.marketingVersion) {
    throw new StorePlanStaleError(
      'The saved plan does not match its request.',
      appStoreReleasePlanCommand,
    );
  }
  return raw as unknown as AppStoreReleasePlanFile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
