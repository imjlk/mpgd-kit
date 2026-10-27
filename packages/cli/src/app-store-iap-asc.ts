import type {
  AscIap,
  AscIapLocalization,
  AscIapPort,
  AscIapReviewScreenshot,
  AscIapVersion,
} from './app-store-iap-port.js';
import {
  ascExitNotFound,
  isEmptyResource,
  isRecord,
  list,
  ascListTimeoutMs as listTimeoutMs,
  ascLookupTimeoutMs as lookupTimeoutMs,
  openAscSession,
  optionalString,
  relationshipId,
  requiredString,
  single,
  ascUploadTimeoutMs as uploadTimeoutMs,
  type AscCommandRunner,
  type AscCredential,
} from './asc-session.js';
import { ReleaseProcessError } from './deploy-process.js';
import { sameDecimal } from './store-products.js';

export type { AscCommandRunner, AscCredential } from './asc-session.js';

/**
 * The in-app purchase port on the pinned `asc` 5.5.0 CLI (`asc-session.ts`).
 * Each method is one `asc ... --output json` command.
 */

/** Copy and verify the pinned binary; `close` removes it. */
export async function openAscIapSession(
  credential: AscCredential,
  signal?: AbortSignal,
): Promise<{ readonly port: AscIapPort; close(): void }> {
  const session = await openAscSession(credential, signal);
  return { port: createAscIapPort(session.run), close: () => session.close() };
}

/** The port over any runner; the tests drive it with recorded asc output. */
export function createAscIapPort(
  run: AscCommandRunner,
  today: () => string = () => new Date().toISOString().slice(0, 10),
): AscIapPort {
  const optional = async (args: readonly string[]): Promise<unknown> => {
    try {
      return await run(args, lookupTimeoutMs);
    } catch (error) {
      if (error instanceof ReleaseProcessError && error.exitCode === ascExitNotFound) {
        return undefined;
      }
      throw error;
    }
  };
  return {
    async readAppBundleId(appId) {
      const app = single(await run(['apps', 'view', '--id', appId], lookupTimeoutMs), 'apps view');
      const bundleId = app.attributes.bundleId;
      if (app.id !== appId || typeof bundleId !== 'string') {
        throw new Error('asc apps view returned no bundle ID for the app.');
      }
      return bundleId;
    },
    async listIaps(appId) {
      return list(await run(['iap', 'list', '--app', appId, '--paginate'], listTimeoutMs), 'iap list')
        .map((resource): AscIap => ({
          id: resource.id,
          productId: requiredString(resource.attributes.productId, 'iap list productId'),
          name: requiredString(resource.attributes.name, 'iap list name'),
          inAppPurchaseType: requiredString(resource.attributes.inAppPurchaseType, 'iap list type'),
          ...optionalString('state', resource.attributes.state),
          ...optionalString('reviewNote', resource.attributes.reviewNote),
          ...(resource.attributes.familySharable === true ? { familySharable: true } : {}),
        }));
    },
    async listVersions(iapId) {
      return list(
        await run(['iap', 'versions', 'list', '--iap-id', iapId, '--paginate'], listTimeoutMs),
        'iap versions list',
      ).map((resource): AscIapVersion => ({
        id: resource.id,
        ...(typeof resource.attributes.version === 'number' ? { version: resource.attributes.version } : {}),
        ...optionalString('state', resource.attributes.state),
      }));
    },
    async listLocalizations(versionId) {
      return list(
        await run(
          ['iap', 'versions', 'localizations', 'list', '--version-id', versionId, '--paginate'],
          listTimeoutMs,
        ),
        'iap versions localizations list',
      ).map((resource): AscIapLocalization => ({
        id: resource.id,
        locale: requiredString(resource.attributes.locale, 'localization locale'),
        name: requiredString(resource.attributes.name, 'localization name'),
        ...optionalString('description', resource.attributes.description),
      }));
    },
    async readPriceSchedule(iapId) {
      const response = await optional(
        ['iap', 'pricing', 'schedules', 'view', '--iap-id', iapId, '--include', 'baseTerritory'],
      );
      // No schedule: asc exits 4 (not found), or App Store Connect answers with no resource.
      if (response === undefined || isEmptyResource(response)) {
        return undefined;
      }
      const schedule = single(response, 'iap pricing schedules view');
      const baseTerritory = relationshipId(schedule.relationships, 'baseTerritory');
      const resolved = await run(
        ['iap', 'pricing', 'schedules', 'manual-prices', '--schedule-id', schedule.id, '--resolved'],
        listTimeoutMs,
      );
      if (!isRecord(resolved) || !Array.isArray(resolved.prices)) {
        throw new Error('asc iap pricing schedules manual-prices returned no prices.');
      }
      const manualPrices = resolved.prices.flatMap((row) =>
        isRecord(row) && row.manual === true && typeof row.territory === 'string'
          && typeof row.customerPrice === 'string'
          ? [{ territory: row.territory, customerPrice: row.customerPrice }]
          : [],
      );
      if (baseTerritory === undefined && manualPrices.length === 0) {
        return undefined;
      }
      // `--resolved` lists only prices in effect; the raw list also holds future ones.
      const all = list(await run(
        ['iap', 'pricing', 'schedules', 'manual-prices', '--schedule-id', schedule.id, '--paginate'],
        listTimeoutMs,
      ), 'iap pricing schedules manual-prices');
      const now = today();
      // A future start or a future end (a temporary price expiring) is a
      // transition a new open-ended schedule would remove.
      const upcoming = (value: unknown): boolean => typeof value === 'string' && value.slice(0, 10) > now;
      const scheduledChanges = all.filter((price) =>
        upcoming(price.attributes.startDate) || upcoming(price.attributes.endDate),
      ).length;
      return {
        id: schedule.id,
        ...(baseTerritory === undefined ? {} : { baseTerritory }),
        manualPrices,
        scheduledChanges,
      };
    },
    async readAvailability(iapId) {
      let response: unknown;
      try {
        response = await run(['iap', 'pricing', 'availability', 'view', '--iap-id', iapId], lookupTimeoutMs);
      } catch (error) {
        // asc 5.5.0 reports an unset availability as an error naming it (availability.go).
        if (error instanceof ReleaseProcessError
          && (error.exitCode === ascExitNotFound || error.output.includes('has no availability configured'))) {
          return undefined;
        }
        throw error;
      }
      if (isEmptyResource(response)) {
        return undefined;
      }
      const availability = single(response, 'iap pricing availability view');
      const territories = list(await run(
        ['iap', 'pricing', 'availabilities', 'available-territories', '--id', availability.id, '--paginate'],
        listTimeoutMs,
      ), 'iap pricing availabilities available-territories').map((territory) => territory.id);
      return {
        id: availability.id,
        availableInNewTerritories: availability.attributes.availableInNewTerritories === true,
        territories,
      };
    },
    async readReviewScreenshot(iapId) {
      const response = await optional(['iap', 'review-screenshots', 'view', '--iap-id', iapId]);
      if (!isRecord(response) || !isRecord(response.data) || typeof response.data.id !== 'string'
        || response.data.id === '') {
        return undefined;
      }
      const attributes = isRecord(response.data.attributes) ? response.data.attributes : {};
      return {
        id: response.data.id,
        ...optionalString('fileName', attributes.fileName),
        ...(typeof attributes.fileSize === 'number' ? { fileSize: attributes.fileSize } : {}),
        ...optionalString('sourceFileChecksum', attributes.sourceFileChecksum),
        ...optionalString(
          'deliveryState',
          isRecord(attributes.assetDeliveryState) ? attributes.assetDeliveryState.state : undefined,
        ),
      } satisfies AscIapReviewScreenshot;
    },
    async listTerritories() {
      const territories = list(
        await run(['pricing', 'territories', 'list', '--paginate'], listTimeoutMs),
        'pricing territories list',
      ).map((resource) => resource.id);
      if (territories.length === 0) {
        throw new Error('asc pricing territories list returned no territories.');
      }
      return territories;
    },
    async createIap(input) {
      const created = single(await run([
        'iap', 'create',
        '--app', input.appId,
        '--type', input.type,
        '--ref-name', input.referenceName,
        '--product-id', input.productId,
        ...(input.familySharable ? ['--family-sharable'] : []),
      ], lookupTimeoutMs), 'iap create');
      return created.id;
    },
    async updateIap(input) {
      await run([
        'iap', 'update',
        '--id', input.iapId,
        ...(input.referenceName === undefined ? [] : ['--ref-name', input.referenceName]),
        ...(input.familySharable === true ? ['--family-sharable'] : []),
      ], lookupTimeoutMs);
    },
    async createVersion(iapId) {
      return single(
        await run(['iap', 'versions', 'create', '--iap-id', iapId], lookupTimeoutMs),
        'iap versions create',
      ).id;
    },
    async createLocalization(input) {
      await run([
        'iap', 'versions', 'localizations', 'create',
        '--version-id', input.versionId,
        '--locale', input.locale,
        '--name', input.name,
        '--description', input.description,
      ], lookupTimeoutMs);
    },
    async updateLocalization(input) {
      await run([
        'iap', 'versions', 'localizations', 'update',
        '--localization-id', input.localizationId,
        '--name', input.name,
        '--description', input.description,
      ], lookupTimeoutMs);
    },
    async findPricePoint(input) {
      const points = list(await run([
        'iap', 'pricing', 'price-points', 'list',
        '--iap-id', input.iapId,
        '--territory', input.territory,
        '--price', input.customerPrice,
        '--paginate',
      ], listTimeoutMs), 'iap pricing price-points list').filter((point) =>
        typeof point.attributes.customerPrice === 'string'
        && sameDecimal(point.attributes.customerPrice, input.customerPrice),
      );
      const [point] = points;
      if (points.length !== 1 || point === undefined) {
        throw new Error(
          `App Store Connect has ${points.length} price points of ${input.customerPrice} in ${input.territory}; `
          + 'use a price that is an App Store price point there.',
        );
      }
      return point.id;
    },
    async createPriceSchedule(input) {
      await run([
        'iap', 'pricing', 'schedules', 'create',
        '--iap-id', input.iapId,
        '--base-territory', input.baseTerritory,
        '--prices', input.pricePointIds.join(','),
      ], lookupTimeoutMs);
    },
    async setAvailability(input) {
      await run([
        'iap', 'pricing', 'availability', 'set',
        '--iap-id', input.iapId,
        '--territories', input.territories.join(','),
        ...(input.availableInNewTerritories ? ['--available-in-new-territories'] : []),
      ], lookupTimeoutMs);
    },
    async deleteReviewScreenshot(screenshotId) {
      await run(
        ['iap', 'review-screenshots', 'delete', '--screenshot-id', screenshotId, '--confirm'],
        lookupTimeoutMs,
      );
    },
    async uploadReviewScreenshot(input) {
      await run(
        ['iap', 'review-screenshots', 'create', '--iap-id', input.iapId, '--file', input.file],
        uploadTimeoutMs,
      );
    },
  };
}
