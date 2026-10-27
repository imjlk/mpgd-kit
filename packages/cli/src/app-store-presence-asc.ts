import type {
  AscAppInfo,
  AscAppInfoLocalization,
  AscAppStoreVersion,
  AscScreenshot,
  AscScreenshotSet,
  AscStorePresencePort,
  AscVersionLocalization,
  AscVersionLocalizationFields,
} from './app-store-presence-port.js';
import {
  ascListTimeoutMs,
  ascLookupTimeoutMs,
  ascUploadTimeoutMs,
  isRecord,
  list,
  openAscSession,
  optionalString,
  requiredString,
  single,
  type AscCommandRunner,
  type AscCredential,
  type AscJsonResource,
} from './asc-session.js';

/**
 * The store page port on the pinned `asc` 5.5.0 CLI. Commands (5.5.0 source,
 * `internal/cli/...`):
 *
 * - `apps view`, `apps info list` (`apps/app_infos.go`)
 * - `localizations list --type app-info` and `--version` (`localizations/localizations.go`)
 * - `app-setup info set` (`apps/app_setup.go`): creates or updates one app
 *   information localization
 * - `versions list` (`versions/versions.go`)
 * - `localizations create` and `localizations update --id` (`localizations/create.go`, `update.go`)
 * - `screenshots list|upload|delete` (`assets/assets_screenshots*.go`): an
 *   upload of one file appends it to the set and waits for the asset
 *   delivery to reach `COMPLETE`, failing on `FAILED`
 */

/** Copy and verify the pinned binary; `close` removes it. */
export async function openAscStorePresenceSession(
  credential: AscCredential,
  signal?: AbortSignal,
): Promise<{ readonly port: AscStorePresencePort; close(): void }> {
  const session = await openAscSession(credential, signal);
  return { port: createAscStorePresencePort(session.run), close: () => session.close() };
}

/** The port over any runner; the tests drive it with recorded asc output. */
export function createAscStorePresencePort(run: AscCommandRunner): AscStorePresencePort {
  return {
    async readAppBundleId(appId) {
      const app = single(await run(['apps', 'view', '--id', appId], ascLookupTimeoutMs), 'apps view');
      const bundleId = app.attributes.bundleId;
      if (app.id !== appId || typeof bundleId !== 'string') {
        throw new Error('asc apps view returned no bundle ID for the app.');
      }
      return bundleId;
    },
    async listAppInfos(appId) {
      return list(await run(['apps', 'info', 'list', '--app', appId], ascLookupTimeoutMs), 'apps info list')
        .map((resource): AscAppInfo => ({
          id: resource.id,
          ...optionalString('state', resource.attributes.state ?? resource.attributes.appStoreState),
        }));
    },
    async listAppInfoLocalizations(appId, appInfoId) {
      return list(await run([
        'localizations', 'list',
        '--type', 'app-info',
        '--app', appId,
        '--app-info', appInfoId,
        '--paginate',
      ], ascListTimeoutMs), 'localizations list --type app-info').map((resource): AscAppInfoLocalization => ({
        id: resource.id,
        locale: requiredString(resource.attributes.locale, 'app info localization locale'),
        ...optionalString('name', resource.attributes.name),
        ...optionalString('subtitle', resource.attributes.subtitle),
        ...optionalString('privacyPolicyUrl', resource.attributes.privacyPolicyUrl),
      }));
    },
    async listVersions(appId) {
      return list(
        await run(['versions', 'list', '--app', appId, '--platform', 'IOS', '--paginate'], ascListTimeoutMs),
        'versions list',
      ).map((resource): AscAppStoreVersion => ({
        id: resource.id,
        ...optionalString('versionString', resource.attributes.versionString),
        ...optionalString('state', resource.attributes.appVersionState ?? resource.attributes.appStoreState),
        ...optionalString('createdDate', resource.attributes.createdDate),
      }));
    },
    async listVersionLocalizations(versionId) {
      return list(
        await run(['localizations', 'list', '--version', versionId, '--paginate'], ascListTimeoutMs),
        'localizations list',
      ).map((resource): AscVersionLocalization => ({
        id: resource.id,
        locale: requiredString(resource.attributes.locale, 'version localization locale'),
        ...versionFields(resource),
      }));
    },
    async listScreenshotSets(versionLocalizationId) {
      const result = await run(
        ['screenshots', 'list', '--version-localization', versionLocalizationId],
        ascListTimeoutMs,
      );
      if (!isRecord(result) || !Array.isArray(result.sets)) {
        throw new Error('asc screenshots list returned no screenshot sets.');
      }
      return result.sets.map((entry): AscScreenshotSet => {
        const set = isRecord(entry) ? single({ data: entry.set }, 'screenshots list set') : undefined;
        const screenshots = isRecord(entry) ? list({ data: entry.screenshots }, 'screenshots list') : undefined;
        if (set === undefined || screenshots === undefined) {
          throw new Error('asc screenshots list returned a malformed set.');
        }
        return {
          id: set.id,
          displayType: requiredString(set.attributes.screenshotDisplayType, 'screenshot display type'),
          screenshots: screenshots.map(toScreenshot),
        };
      });
    },
    async upsertAppInfoLocalization(input) {
      await run([
        'app-setup', 'info', 'set',
        '--app', input.appId,
        '--app-info', input.appInfoId,
        '--locale', input.locale,
        '--name', input.name,
        ...(input.subtitle === undefined ? [] : ['--subtitle', input.subtitle]),
        ...(input.privacyPolicyUrl === undefined ? [] : ['--privacy-policy-url', input.privacyPolicyUrl]),
      ], ascLookupTimeoutMs);
    },
    async createVersionLocalization(input) {
      return single(await run([
        'localizations', 'create',
        '--version', input.versionId,
        '--locale', input.locale,
        ...fieldFlags(input.fields),
      ], ascLookupTimeoutMs), 'localizations create').id;
    },
    async updateVersionLocalization(input) {
      const flags = fieldFlags(input.fields);
      if (flags.length === 0) {
        return;
      }
      await run(['localizations', 'update', '--id', input.localizationId, ...flags], ascLookupTimeoutMs);
    },
    async uploadScreenshot(input) {
      const result = await run([
        'screenshots', 'upload',
        '--version-localization', input.versionLocalizationId,
        '--path', input.file,
        '--device-type', input.displayType,
      ], ascUploadTimeoutMs);
      const results = isRecord(result) && Array.isArray(result.results) ? result.results : [];
      const [item] = results;
      if (results.length !== 1 || !isRecord(item) || typeof item.assetId !== 'string' || item.assetId === '') {
        throw new Error('asc screenshots upload returned no uploaded screenshot.');
      }
      const state = typeof item.state === 'string' ? item.state.toUpperCase() : '';
      if (state !== 'COMPLETE') {
        throw new Error(`App Store Connect reports screenshot ${item.assetId} as ${state || 'not delivered'}.`);
      }
      return { id: item.assetId, deliveryState: state };
    },
    async deleteScreenshot(screenshotId) {
      await run(['screenshots', 'delete', '--id', screenshotId, '--confirm'], ascLookupTimeoutMs);
    },
  };
}

const fieldNames = [
  ['description', '--description'],
  ['keywords', '--keywords'],
  ['promotionalText', '--promotional-text'],
  ['whatsNew', '--whats-new'],
  ['supportUrl', '--support-url'],
  ['marketingUrl', '--marketing-url'],
] as const;

function fieldFlags(fields: AscVersionLocalizationFields): string[] {
  return fieldNames.flatMap(([field, flag]) => {
    const value = fields[field];
    return value === undefined ? [] : [flag, value];
  });
}

function versionFields(resource: AscJsonResource): AscVersionLocalizationFields {
  return Object.assign(
    {},
    ...fieldNames.map(([field]) => optionalString(field, resource.attributes[field])),
  ) as
    AscVersionLocalizationFields;
}

function toScreenshot(resource: AscJsonResource): AscScreenshot {
  const delivery = resource.attributes.assetDeliveryState;
  return {
    id: resource.id,
    ...optionalString('fileName', resource.attributes.fileName),
    ...optionalString('sourceFileChecksum', resource.attributes.sourceFileChecksum),
    ...optionalString('deliveryState', isRecord(delivery) ? delivery.state : undefined),
  };
}
