import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  appStorePresenceDisplays,
  appStorePresenceDisplayTypes,
  appStorePresenceLimits,
  resolveStorePresenceImageSet,
  type AppStorePresence,
  type AppStorePresenceDisplay,
  type AppStorePresenceLocalization,
  type StorePresence,
} from '@mpgd/catalog';

import type {
  AscAppInfoLocalization,
  AscAppStoreVersion,
  AscScreenshotSet,
  AscStorePresencePort,
  AscVersionLocalization,
  AscVersionLocalizationFields,
} from './app-store-presence-port.js';
import {
  describeTextChange,
  formatTextChange,
  normalizeLineBreaks,
  planStoreImageSet,
  readLocalStoreImage,
  storePresencePlanCommand,
  type LocalStoreImage,
  type StorePresenceTextChange,
} from './store-presence.js';
import { ReleaseProcessError } from './deploy-process.js';
import {
  canonicalLanguageTag,
  mapWithConcurrency,
  stableSha256,
  StorePlanStaleError,
} from './store-sync.js';

/**
 * App Store Connect store page sync: compare the store presence file with
 * the app information localizations (name, subtitle, privacy policy URL),
 * the editable App Store version's localizations (description, keywords,
 * promotional text, what's new, URLs) and its screenshot sets, and plan the
 * writes.
 *
 * The sync writes only to an editable app information record and an
 * editable iOS version (`PREPARE_FOR_SUBMISSION` or rejected). It never
 * creates a version, never submits for review, and never touches pricing,
 * availability or release settings. App Store Connect has no transaction:
 * apply writes step by step and, on a failure, names the steps already
 * written; `plan` then shows what is left.
 */

export type AppStorePresenceAction = 'create' | 'update' | 'unchanged' | 'blocked';

export interface PlannedAscScreenshotSet {
  readonly display: AppStorePresenceDisplay;
  readonly displayType: string;
  readonly action: 'unchanged' | 'add' | 'replace';
  readonly complete: boolean;
  /** Uploads, in order, by path relative to the file and MD5. */
  readonly upload: readonly { readonly path: string; readonly md5: string }[];
  /** MD5 of App Store Connect's screenshots that stay. */
  readonly keep: readonly string[];
  /** App Store Connect's screenshots the write removes and does not upload again. */
  readonly remove: readonly { readonly id: string; readonly md5: string }[];
  /** `replace`: every screenshot of the set, deleted before the uploads. */
  readonly deleteIds: readonly string[];
  /** The set cannot be planned now (App Store Connect is still processing it). */
  readonly blocked?: true;
  readonly notes: readonly string[];
}

export interface PlannedAppStoreLocale {
  /** The locale as App Store Connect spells it (BCP-47 casing for a new one). */
  readonly locale: string;
  readonly appInfo: {
    readonly action: AppStorePresenceAction;
    readonly text: readonly StorePresenceTextChange[];
    readonly write?: { readonly name: string; readonly subtitle?: string; readonly privacyPolicyUrl?: string };
  };
  readonly version: {
    readonly action: AppStorePresenceAction;
    readonly localizationId?: string;
    readonly text: readonly StorePresenceTextChange[];
    readonly write?: AscVersionLocalizationFields;
  };
  readonly screenshots: readonly PlannedAscScreenshotSet[];
}

export interface AppStorePresencePlan {
  readonly schemaVersion: 1;
  readonly store: 'app-store';
  /** Numeric App Store Connect app ID. */
  readonly appId: string;
  readonly bundleId: string;
  /** The editable app information record, when there is one. */
  readonly appInfo?: { readonly id: string; readonly state: string };
  /** The editable iOS version, when there is one. */
  readonly version?: {
    readonly id: string;
    readonly versionString?: string;
    readonly state: string;
    /** The app's first version: App Store Connect takes no what's new text. */
    readonly first: boolean;
  };
  readonly locales: readonly PlannedAppStoreLocale[];
  /** Locales on App Store Connect that the file does not name. Never deleted. */
  readonly remoteOnlyLocales: readonly string[];
  /**
   * Screenshots apply deletes: the ones a complete set drops, and every one
   * of a set it replaces (re-uploaded after). Apply needs --confirm-image-removal.
   */
  readonly imageRemovals: number;
  readonly changed: boolean;
  /** Parts that differ but cannot be written now (nothing editable, still processing). */
  readonly blocked: number;
  readonly notes: readonly string[];
  /** What the sync cannot do; the reviewer does it in App Store Connect. */
  readonly manual: readonly string[];
  readonly remoteSha256: string;
  readonly desiredSha256: string;
}

export interface AppStorePresencePlanInput {
  readonly appId: string;
  readonly bundleId: string;
  readonly presence: StorePresence;
  /** Directory of the store presence file; screenshots resolve against it. */
  readonly directory: string;
}

// App information states whose localizations App Store Connect accepts edits
// for, and the iOS version states the sync writes to (App Store Connect API
// `AppInfoState` and `AppVersionState`).
const editableAppInfoStates = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED']);
const editableVersionStates = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
]);
/** Version states after a release (both spellings): what's new is accepted from then on. */
const releasedVersionStates = new Set([
  'READY_FOR_DISTRIBUTION',
  'PROCESSING_FOR_DISTRIBUTION',
  'REPLACED_WITH_NEW_VERSION',
  'READY_FOR_SALE',
  'DEVELOPER_REMOVED_FROM_SALE',
  'REMOVED_FROM_SALE',
]);
/** App information states of the live record (asc `isNonLiveAppInfoState`). */
const liveAppInfoStates = new Set(['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE']);
const readConcurrency = 4;

/** Read App Store Connect and plan; never writes. */
export async function planAppStorePresence(
  input: AppStorePresencePlanInput,
  port: AscStorePresencePort,
): Promise<AppStorePresencePlan> {
  const appStore = requireAppStore(input.presence);
  const local = readLocalScreenshots(input.directory, appStore);
  return planWithLocal(input, appStore, local, port);
}

function requireAppStore(presence: StorePresence): AppStorePresence {
  if (presence.appStore === undefined) {
    throw new Error('The store presence file has no appStore section.');
  }
  return presence.appStore;
}

type LocalScreenshots = ReadonlyMap<string, ReadonlyMap<AppStorePresenceDisplay, {
  readonly images: readonly LocalStoreImage[];
  readonly complete: boolean;
}>>;

function readLocalScreenshots(directory: string, appStore: AppStorePresence): LocalScreenshots {
  const result = new Map<string, Map<AppStorePresenceDisplay, { images: LocalStoreImage[]; complete: boolean }>>();
  for (const [locale, entry] of Object.entries(appStore.localizations)) {
    const sets = new Map<AppStorePresenceDisplay, { images: LocalStoreImage[]; complete: boolean }>();
    for (const display of appStorePresenceDisplays) {
      const value = entry.screenshots?.[display];
      if (value === undefined) {
        continue;
      }
      const { files, complete } = resolveStorePresenceImageSet(value);
      const label = `appStore.localizations.${locale}.screenshots.${display}`;
      const images = files.map((file) =>
        readLocalStoreImage(directory, file, { store: 'app-store', slot: display }, label),
      );
      if (new Set(images.map((image) => image.md5)).size !== images.length) {
        throw new Error(`${label} lists the same image twice under different names.`);
      }
      sets.set(display, { images, complete });
    }
    result.set(locale, sets);
  }
  return result;
}

async function planWithLocal(
  input: AppStorePresencePlanInput,
  appStore: AppStorePresence,
  local: LocalScreenshots,
  port: AscStorePresencePort,
): Promise<AppStorePresencePlan> {
  const bundleId = await port.readAppBundleId(input.appId);
  if (bundleId !== input.bundleId) {
    throw new Error(
      `App Store Connect app ${input.appId} has bundle ID ${bundleId}, not ${input.bundleId} from the deployment profile.`,
    );
  }
  const notes: string[] = [];
  const manual: string[] = [];

  // App information: the editable record, else the current one (read only).
  const appInfos = await port.listAppInfos(input.appId);
  const editableInfos = appInfos.filter((info) => editableAppInfoStates.has(String(info.state)));
  if (editableInfos.length > 1) {
    throw new Error(
      `App Store Connect app ${input.appId} has ${editableInfos.length} editable app information records; `
      + 'finish or remove all but one.',
    );
  }
  const appInfo = editableInfos[0];
  // Without an editable record, read the live one, not a replaced older one.
  const readInfo = appInfo
    ?? appInfos.find((info) => liveAppInfoStates.has(String(info.state)))
    ?? appInfos.find((info) => info.state !== 'REPLACED_WITH_NEW_INFO')
    ?? appInfos[0];
  const appInfoLocalizations = readInfo === undefined
    ? []
    : await port.listAppInfoLocalizations(input.appId, readInfo.id);
  if (appInfo === undefined) {
    manual.push(
      'App name, subtitle and privacy policy URL are editable only while an app information record is being '
      + 'prepared (a new version in PREPARE_FOR_SUBMISSION or rejected); the plan shows what would change.',
    );
  }

  // The editable iOS version; the sync never creates one.
  const versions = await port.listVersions(input.appId);
  const editableVersions = versions.filter((version) =>
    editableVersionStates.has(String(version.state)),
  );
  if (editableVersions.length > 1) {
    throw new Error(
      `App Store Connect app ${input.appId} has ${editableVersions.length} editable iOS versions; finish or remove all but one.`,
    );
  }
  const version = editableVersions[0];
  // App Store Connect takes what's new only once a version has been released.
  const first = version !== undefined && !versions.some((candidate) =>
    releasedVersionStates.has(String(candidate.state)) || releasedVersionStates.has(String(candidate.appStoreState)));
  if (version === undefined) {
    manual.push(
      'No iOS version is editable (PREPARE_FOR_SUBMISSION or rejected): create the next version in App Store '
      + 'Connect, then plan again. The sync never creates or submits a version.',
    );
  }
  const versionLocalizations = version === undefined
    ? []
    : await port.listVersionLocalizations(version.id);

  const infoByLocale = indexByLocale(appInfoLocalizations);
  const versionByLocale = indexByLocale(versionLocalizations);
  const locales = Object.keys(appStore.localizations);
  const setReads = version === undefined
    ? []
    : locales.flatMap((locale) => {
        const remote = versionByLocale.get(locale.toLowerCase());
        return remote !== undefined && (local.get(locale)?.size ?? 0) > 0
          ? [{ locale, id: remote.id }]
          : [];
      });
  const setLists = await mapWithConcurrency(setReads, readConcurrency, (read) =>
    port.listScreenshotSets(read.id),
  );
  const remoteSets = new Map<string, AscScreenshotSet[]>();
  setReads.forEach((read, index) => remoteSets.set(read.locale, setLists[index] ?? []));

  const planned = locales.map((locale) =>
    planLocale({
      locale,
      entry: appStore.localizations[locale] as AppStorePresenceLocalization,
      privacyPolicyUrl: input.presence.privacyPolicyUrl,
      appInfoEditable: appInfo !== undefined,
      remoteInfo: infoByLocale.get(locale.toLowerCase()),
      version,
      first,
      remoteVersion: versionByLocale.get(locale.toLowerCase()),
      local: local.get(locale) ?? new Map(),
      remoteSets: remoteSets.get(locale) ?? [],
      notes,
    }),
  );
  if (first && locales.some((locale) => appStore.localizations[locale]?.whatsNew !== undefined)) {
    notes.push(
      "No version of the app has been released yet: App Store Connect takes no what's new text, so the sync "
      + 'leaves it out.',
    );
  }
  const named = new Set(locales.map((locale) => locale.toLowerCase()));
  const remoteOnlyLocales = [...new Set([...appInfoLocalizations, ...versionLocalizations].map((entry) => entry.locale))]
    .filter((locale) => !named.has(locale.toLowerCase()))
    .sort();
  manual.push(
    'App Privacy answers, the age rating, App Review notes and demo account, pricing, availability, release '
    + 'settings and submitting for review stay in App Store Connect.',
  );
  const imageRemovals = planned.reduce(
    (sum, locale) => sum + locale.screenshots.reduce(
      (count, set) => count + (set.action === 'replace' ? set.deleteIds.length : 0),
      0,
    ),
    0,
  );
  const blocked = planned.reduce(
    (sum, locale) => sum + [locale.appInfo.action, locale.version.action].filter((action) => action === 'blocked').length
      + locale.screenshots.filter((set) => set.blocked === true).length,
    0,
  );
  const writes = (action: AppStorePresenceAction): boolean => action === 'create' || action === 'update';
  const changed = planned.some((locale) =>
    writes(locale.appInfo.action) || writes(locale.version.action)
    || locale.screenshots.some((set) => set.action !== 'unchanged'),
  );
  const remoteSha256 = stableSha256({
    appInfo: readInfo === undefined
      ? null
      : { id: readInfo.id, state: readInfo.state, editable: appInfo !== undefined },
    appInfoLocalizations: sortByLocale(appInfoLocalizations),
    version: version ?? null,
    first,
    versionLocalizations: sortByLocale(versionLocalizations),
    screenshotSets: Object.fromEntries(
      [...remoteSets.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
  return {
    schemaVersion: 1,
    store: 'app-store',
    appId: input.appId,
    bundleId: input.bundleId,
    ...(appInfo === undefined ? {} : { appInfo: { id: appInfo.id, state: String(appInfo.state) } }),
    ...(version === undefined ? {} : {
      version: {
        id: version.id,
        ...(version.versionString === undefined ? {} : { versionString: version.versionString }),
        state: String(version.state),
        first,
      },
    }),
    locales: planned,
    remoteOnlyLocales,
    imageRemovals,
    changed,
    blocked,
    notes,
    manual,
    remoteSha256,
    desiredSha256: stableSha256({ locales: planned }),
  };
}

function planLocale(input: {
  readonly locale: string;
  readonly entry: AppStorePresenceLocalization;
  readonly privacyPolicyUrl: string | undefined;
  readonly appInfoEditable: boolean;
  readonly remoteInfo: AscAppInfoLocalization | undefined;
  readonly version: AscAppStoreVersion | undefined;
  readonly first: boolean;
  readonly remoteVersion: AscVersionLocalization | undefined;
  readonly local: ReadonlyMap<AppStorePresenceDisplay, { readonly images: readonly LocalStoreImage[]; readonly complete: boolean }>;
  readonly remoteSets: readonly AscScreenshotSet[];
  readonly notes: string[];
}): PlannedAppStoreLocale {
  const { entry, remoteInfo, remoteVersion } = input;
  const locale = remoteVersion?.locale ?? remoteInfo?.locale ?? canonicalLanguageTag(input.locale);

  // App information: name, subtitle and privacy policy URL.
  const privacyPolicyUrl = entry.privacyPolicyUrl ?? input.privacyPolicyUrl;
  const infoText = [
    describeTextChange('name', remoteInfo?.name, entry.name),
    entry.subtitle === undefined ? undefined : describeTextChange('subtitle', remoteInfo?.subtitle, entry.subtitle),
    privacyPolicyUrl === undefined
      ? undefined
      : describeTextChange('privacyPolicyUrl', remoteInfo?.privacyPolicyUrl, privacyPolicyUrl),
  ].filter((change) => change !== undefined);
  const infoChanges = remoteInfo === undefined || infoText.length > 0;
  const infoAction: AppStorePresenceAction = !infoChanges
    ? 'unchanged'
    : !input.appInfoEditable
      ? 'blocked'
      : remoteInfo === undefined
        ? 'create'
        : 'update';

  // Version localization: only the fields the file gives; what's new not on a first version.
  const desired: AscVersionLocalizationFields = {
    description: normalizeLineBreaks(entry.description),
    keywords: entry.keywords,
    supportUrl: entry.supportUrl,
    ...(entry.promotionalText === undefined
      ? {}
      : { promotionalText: normalizeLineBreaks(entry.promotionalText) }),
    ...(entry.whatsNew === undefined || input.first ? {} : { whatsNew: normalizeLineBreaks(entry.whatsNew) }),
    ...(entry.marketingUrl === undefined ? {} : { marketingUrl: entry.marketingUrl }),
  };
  const versionText: StorePresenceTextChange[] = [];
  const changedFields: Record<string, string> = {};
  for (const [field, value] of Object.entries(
    desired,
  ) as [keyof AscVersionLocalizationFields, string][]) {
    const change = describeTextChange(field, remoteVersion?.[field], value);
    if (change !== undefined) {
      versionText.push(change);
      changedFields[field] = value;
    }
  }
  // A new locale needs its app information (the name) first: without an
  // editable record it would be half added, so its version part waits too.
  const waitsForAppInfo = remoteInfo === undefined && !input.appInfoEditable && remoteVersion === undefined;
  if (waitsForAppInfo && input.version !== undefined) {
    input.notes.push(
      `${locale}: not on App Store Connect yet and no app information record is editable, so its version `
      + 'localization and screenshots wait too.',
    );
  }
  const versionAction: AppStorePresenceAction = input.version === undefined || waitsForAppInfo
    ? 'blocked'
    : remoteVersion === undefined
      ? 'create'
      : versionText.length > 0
        ? 'update'
        : 'unchanged';

  // Screenshot sets of the version localization.
  const screenshots: PlannedAscScreenshotSet[] = [];
  if (input.version !== undefined && !waitsForAppInfo) {
    for (const display of appStorePresenceDisplays) {
      const set = input.local.get(display);
      if (set === undefined) {
        continue;
      }
      const displayType = appStorePresenceDisplayTypes[display];
      const remoteSet = input.remoteSets.find((candidate) => candidate.displayType === displayType);
      const remote = remoteSet?.screenshots ?? [];
      const processing = remote.find((screenshot) =>
        (screenshot.deliveryState === 'COMPLETE' && (screenshot.sourceFileChecksum ?? '') === '')
        || screenshot.deliveryState === 'AWAITING_UPLOAD' || screenshot.deliveryState === 'UPLOAD_COMPLETE');
      if (processing !== undefined) {
        // Only this set waits; the text and the other sets still plan.
        screenshots.push({
          display,
          displayType,
          action: 'unchanged',
          blocked: true,
          complete: set.complete,
          upload: [],
          keep: [],
          remove: [],
          deleteIds: [],
          notes: [
            `App Store Connect is still processing screenshot ${processing.id} (${String(processing.deliveryState)}); `
            + 'plan again when it is delivered.',
          ],
        });
        continue;
      }
      const plan = planStoreImageSet({
        local: set.images.map((image) => ({ path: image.path, digest: image.md5 })),
        // A failed delivery counts as no image: a complete set replaces it.
        remote: remote.map((screenshot) => ({
          id: screenshot.id,
          digest: screenshot.deliveryState === undefined || screenshot.deliveryState === 'COMPLETE'
            ? String(screenshot.sourceFileChecksum ?? '').toLowerCase()
            : '',
        })),
        complete: set.complete,
        single: false,
        maxImages: appStorePresenceLimits.screenshots,
        label: `App Store ${locale} ${display}`,
        storeName: 'App Store Connect',
      });
      const pending = remote.filter((screenshot) => screenshot.deliveryState !== undefined
        && screenshot.deliveryState !== 'COMPLETE');
      screenshots.push({
        display,
        displayType,
        action: plan.action,
        complete: set.complete,
        upload: plan.upload.map((image) => ({ path: image.path, md5: image.digest })),
        keep: plan.keep,
        remove: plan.remove.map((image) => ({ id: image.id, md5: image.digest })),
        deleteIds: plan.action === 'replace' ? remote.map((screenshot) => screenshot.id) : [],
        notes: [
          ...plan.notes,
          ...(plan.action === 'replace' && remote.length > 0
            ? [`The whole set (${remote.length}) is deleted, then the file's ${plan.upload.length} uploaded in order.`]
            : []),
          ...pending.map((screenshot) =>
            `Screenshot ${screenshot.id} is ${String(screenshot.deliveryState)}; mark the set complete to replace it.`),
        ],
      });
    }
  } else if (input.local.size > 0 && input.version === undefined) {
    input.notes.push(`${locale}: screenshots wait for an editable version.`);
  }

  return {
    locale,
    appInfo: {
      action: infoAction,
      text: infoText,
      ...(infoAction === 'create' || infoAction === 'update'
        ? {
            write: {
              name: entry.name,
              ...(entry.subtitle === undefined ? {} : { subtitle: entry.subtitle }),
              ...(privacyPolicyUrl === undefined ? {} : { privacyPolicyUrl }),
            },
          }
        : {}),
    },
    version: {
      action: versionAction,
      ...(remoteVersion === undefined ? {} : { localizationId: remoteVersion.id }),
      text: versionText,
      ...(versionAction === 'create' ? { write: desired } : versionAction === 'update' ? { write: changedFields } : {}),
    },
    screenshots,
  };
}

function indexByLocale<T extends { readonly locale: string }>(entries: readonly T[]): Map<string, T> {
  return new Map(entries.map((entry) => [entry.locale.toLowerCase(), entry]));
}

function sortByLocale<T extends { readonly locale: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => left.locale.localeCompare(right.locale));
}

export interface AppStorePresenceApplyResult {
  readonly appId: string;
  readonly status: 'updated' | 'unchanged';
  /** The writes, in order. */
  readonly steps: readonly string[];
  readonly manual: readonly string[];
}

export class AppStorePresenceApplyError extends Error {
  constructor(
    readonly stage: string,
    /** The writes that landed before the failure. */
    readonly written: readonly string[],
    cause: unknown,
    detail?: string,
    /** App Store Connect refused the step (asc exited with a 4xx-class code): nothing from it landed. */
    readonly definitive = false,
  ) {
    super(
      `App Store Connect ${stage} ${definitive ? 'failed; nothing from this step landed' : 'failed or its result is unknown'} (${
        cause instanceof Error ? cause.message : String(cause)}). Written before it: ${
        written.join('; ') || 'nothing'}. ${detail === undefined ? '' : `${detail} `}Run "${
        storePresencePlanCommand}" again: it reads App Store Connect and lists what is left.`,
      { cause },
    );
    this.name = 'AppStorePresenceApplyError';
  }
}

/**
 * Apply a reviewed plan: re-plan, refuse when App Store Connect or the files
 * moved past the reviewed plan, then write step by step. A plan whose
 * changes already landed is a no-op, so a re-run is safe.
 */
export async function applyAppStorePresence(input: {
  readonly saved: AppStorePresencePlan;
  readonly plan: AppStorePresencePlanInput;
  readonly port: AscStorePresencePort;
  readonly approved: boolean;
  readonly confirmImageRemoval?: boolean;
}): Promise<AppStorePresenceApplyResult> {
  const { saved, port } = input;
  const { appId } = input.plan;
  if (!input.approved) {
    throw new Error('Writing the App Store page requires --approve.');
  }
  if (saved.appId !== appId || saved.bundleId !== input.plan.bundleId) {
    throw new StorePlanStaleError(
      `The deployment profile now names app ${appId} (${input.plan.bundleId}), not ${saved.appId} (${saved.bundleId}).`,
      storePresencePlanCommand,
    );
  }
  const appStore = requireAppStore(input.plan.presence);
  const local = readLocalScreenshots(input.plan.directory, appStore);
  const current = await planWithLocal(input.plan, appStore, local, port);
  if (!current.changed) {
    return { appId, status: 'unchanged', steps: [], manual: current.manual };
  }
  if (current.remoteSha256 !== saved.remoteSha256 || current.desiredSha256 !== saved.desiredSha256) {
    throw new StorePlanStaleError(
      'The App Store page or the store presence file changed since the plan.',
      storePresencePlanCommand,
    );
  }
  if (current.imageRemovals > 0 && input.confirmImageRemoval !== true) {
    throw new Error(
      `The plan removes ${current.imageRemovals} screenshot(s) from App Store Connect; confirm with --confirm-image-removal.`,
    );
  }
  const steps: string[] = [];
  let staging: string | undefined;
  let stage = 'start';
  let deletedSet: string | undefined;
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    stage = name;
    const result = await action();
    steps.push(name);
    return result;
  };
  try {
    for (const locale of current.locales) {
      const infoWrite = locale.appInfo.write;
      if (infoWrite !== undefined && current.appInfo !== undefined) {
        const appInfoId = current.appInfo.id;
        await step(`${locale.locale} app information`, () =>
          port.upsertAppInfoLocalization({
            appId,
            appInfoId,
            locale: locale.locale,
            ...infoWrite,
          }),
        );
      }
      if (current.version === undefined) {
        continue;
      }
      const versionId = current.version.id;
      let localizationId = locale.version.localizationId;
      const versionWrite = locale.version.write;
      if (locale.version.action === 'create' && versionWrite !== undefined) {
        localizationId = await step(`${locale.locale} version localization create`, () =>
          port.createVersionLocalization({ versionId, locale: locale.locale, fields: versionWrite }));
      } else if (locale.version.action === 'update' && versionWrite !== undefined && localizationId !== undefined) {
        const id = localizationId;
        await step(`${locale.locale} version localization update`, () =>
          port.updateVersionLocalization({ localizationId: id, fields: versionWrite }),
        );
      }
      for (const set of locale.screenshots) {
        if (set.action === 'unchanged') {
          continue;
        }
        if (localizationId === undefined) {
          throw new Error(`${locale.locale} has no version localization for its screenshots`);
        }
        const versionLocalizationId = localizationId;
        deletedSet = undefined;
        // Every file of the set is read once, checked and copied to a private
        // directory before the set is cleared; asc uploads the copies, so
        // the bytes cannot change during the (minutes-long) uploads, and asc
        // never sees a symbolic link (it refuses a source reached through one).
        const files = set.upload.map((image, index) => {
          const bytes = readFileSync(path.resolve(input.plan.directory, image.path));
          if (createHash('md5').update(bytes).digest('hex') !== image.md5) {
            throw new StorePlanStaleError(
              `${image.path} changed since the plan.`,
              storePresencePlanCommand,
            );
          }
          staging ??= realpathSync(mkdtempSync(path.join(tmpdir(), 'mpgd-asc-screenshots-')));
          const directory = path.join(staging, `${locale.locale}-${set.display}-${index}`);
          mkdirSync(directory, { mode: 0o700 });
          const file = path.join(directory, path.basename(image.path));
          writeFileSync(file, bytes, { mode: 0o600 });
          return { image, file };
        });
        for (const id of set.deleteIds) {
          await step(`${locale.locale} ${set.display} delete ${id}`, () =>
            port.deleteScreenshot(id),
          );
          deletedSet = `${locale.locale} ${set.display}`;
        }
        for (const { image, file } of files) {
          stage = `${locale.locale} ${set.display} upload of ${image.path}`;
          await step(stage, () =>
            port.uploadScreenshot({
              versionLocalizationId,
              displayType: set.displayType,
              file,
            }),
          );
        }
        deletedSet = undefined;
      }
    }
  } catch (error) {
    if (error instanceof StorePlanStaleError && steps.length === 0) {
      throw error;
    }
    throw new AppStorePresenceApplyError(
      stage,
      steps,
      error,
      deletedSet === undefined
        ? undefined
        : `The ${deletedSet} screenshots were deleted before the upload; apply the new plan to upload them again.`,
      // An upload is several App Store Connect calls (reserve, send, commit):
      // even a refused one may have left a reservation behind.
      !stage.includes(' upload of ') && isDefinitiveAscFailure(error),
    );
  } finally {
    if (staging !== undefined) {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { appId, status: 'updated', steps, manual: current.manual };
}

/**
 * asc 5.5.0 exit codes (`cmd/exit_codes.go`): 2 usage, 3 auth, 4 not found,
 * 5 conflict, and 10 + (status - 400) for other 4xx answers. Those are App
 * Store Connect (or asc) refusing the request; 1 (generic, including network
 * failures), 5xx codes, a timeout or an abort leave the result unknown.
 */
function isDefinitiveAscFailure(error: unknown): boolean {
  if (!(error instanceof ReleaseProcessError) || error.reason !== 'exit' || error.exitCode === undefined) {
    return false;
  }
  const code = error.exitCode;
  const timeoutOrRateLimit = code === 10 + (408 - 400) || code === 10 + (429 - 400);
  return (code >= 2 && code <= 5) || (code >= 10 && code < 60 && !timeoutOrRateLimit);
}

/** The plan for the terminal: per locale, the text and screenshot changes. */
export function formatAppStorePresencePlan(plan: AppStorePresencePlan): string {
  const lines = [
    `App Store Connect app ${plan.appId} (${plan.bundleId})${
      plan.version === undefined ? '' : `, version ${plan.version.versionString ?? plan.version.id} ${plan.version.state}`}${
      plan.changed ? '' : plan.blocked > 0 ? ': nothing writable now' : ': no changes'}${
      plan.blocked > 0 ? ` (${plan.blocked} blocked)` : ''}`,
  ];
  for (const locale of plan.locales) {
    lines.push(`  ${locale.locale}`);
    const part = (label: string, action: AppStorePresenceAction, text: readonly StorePresenceTextChange[]): void => {
      if (action === 'unchanged') {
        return;
      }
      lines.push(`    ${action.padEnd(9)} ${label}`);
      for (const change of text) {
        lines.push(`              ${formatTextChange(change)}`);
      }
    };
    part('app information', locale.appInfo.action, locale.appInfo.text);
    part('version localization', locale.version.action, locale.version.text);
    for (const set of locale.screenshots) {
      if (set.action === 'unchanged' && set.notes.length === 0) {
        continue;
      }
      lines.push(
        `    ${set.action.padEnd(9)} ${set.display} (${set.displayType})${set.complete ? ' complete set' : ''}`,
      );
      for (const image of set.upload) {
        lines.push(`              + ${image.path} ${image.md5.slice(0, 12)}`);
      }
      for (const image of set.remove) {
        lines.push(`              - ${image.id} ${image.md5.slice(0, 12) || '(no checksum)'}`);
      }
      for (const note of set.notes) {
        lines.push(`              note: ${note}`);
      }
    }
  }
  for (const locale of plan.remoteOnlyLocales) {
    lines.push(`  remote    ${locale}: only on App Store Connect; not in the file (never deleted)`);
  }
  if (plan.imageRemovals > 0) {
    lines.push(
      `  IMAGE REMOVAL: ${plan.imageRemovals} screenshot(s); apply needs --confirm-image-removal`,
    );
  }
  for (const note of plan.notes) {
    lines.push(`  note      ${note}`);
  }
  for (const step of plan.manual) {
    lines.push(`  manual    ${step}`);
  }
  return lines.join('\n');
}
