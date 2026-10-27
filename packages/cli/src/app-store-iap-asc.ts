import { chmodSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  AscIap,
  AscIapLocalization,
  AscIapPort,
  AscIapReviewScreenshot,
  AscIapVersion,
} from './app-store-iap-port.js';
import { ReleaseProcessError, runReleaseProcess } from './deploy-process.js';
import { sameDecimal } from './store-products.js';
import { isolatedAscEnvironment, verifyPinnedAscBinary } from './testflight-submission.js';

/**
 * The in-app purchase port on the pinned `asc` 5.5.0 CLI, with the same
 * binary pin, isolated environment and API key as the TestFlight
 * submission. Each method is one `asc ... --output json` command; the JSON
 * is App Store Connect's own resource document, which `asc` prints as it
 * received it (`internal/asc/types/resources.go` at the 5.5.0 tag).
 */

/** Runs one asc command with `--output json` appended and returns the parsed JSON. */
export type AscCommandRunner = (args: readonly string[], timeoutMs: number) => Promise<unknown>;

export interface AscCredential {
  readonly ascBinary: string;
  readonly apiKeyId: string;
  readonly apiIssuerId: string;
  readonly apiPrivateKeyBase64: string;
}

const lookupTimeoutMs = 60_000;
const listTimeoutMs = 3 * 60_000;
const uploadTimeoutMs = 10 * 60_000;
const maxJsonBytes = 8 * 1024 * 1024;
/** asc exit code for an App Store Connect 404 (`cmd/exit_codes.go`, 5.5.0). */
const ascExitNotFound = 4;

/** Copy and verify the pinned binary into a private directory; `close` removes it. */
export async function openAscIapSession(
  credential: AscCredential,
  signal?: AbortSignal,
): Promise<{ readonly port: AscIapPort; close(): void }> {
  if (!path.isAbsolute(credential.ascBinary)) {
    throw new Error('asc binary must be an absolute file path.');
  }
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'mpgd-asc-iap-'));
  try {
    const binary = path.join(tempRoot, 'asc');
    copyFileSync(credential.ascBinary, binary);
    chmodSync(binary, 0o700);
    await verifyPinnedAscBinary(binary);
    const environment = isolatedAscEnvironment(credential, tempRoot);
    const run: AscCommandRunner = async (args, timeoutMs) => {
      const result = await runReleaseProcess({
        command: binary,
        args: [...args, '--output', 'json'],
        cwd: tempRoot,
        environment,
        timeoutMs,
        maxOutputBytes: maxJsonBytes,
        captureMachineStdout: true,
        secretValues: [credential.apiKeyId, credential.apiIssuerId, credential.apiPrivateKeyBase64],
        signal,
      });
      if (result.truncated || result.machineStdout === undefined) {
        throw new Error('asc JSON output was truncated or unavailable.');
      }
      try {
        return JSON.parse(result.machineStdout) as unknown;
      } catch {
        throw new Error('asc returned invalid JSON.');
      }
    };
    return {
      port: createAscIapPort(run),
      close: () => rmSync(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
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
      if (response === undefined || (isRecord(response) && response.data === null)) {
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
      if (isRecord(response) && response.data === null) {
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

interface JsonResource {
  readonly id: string;
  readonly attributes: Record<string, unknown>;
  readonly relationships?: unknown;
}

function single(value: unknown, command: string): JsonResource {
  const resource = isRecord(value) ? toResource(value.data) : undefined;
  if (resource === undefined) {
    throw new Error(`asc ${command} returned no resource.`);
  }
  return resource;
}

function list(value: unknown, command: string): JsonResource[] {
  const resources = isRecord(value) && Array.isArray(value.data)
    ? value.data.map(toResource)
    : undefined;
  if (resources === undefined || resources.some((resource) => resource === undefined)) {
    throw new Error(`asc ${command} returned no resource list.`);
  }
  return resources as JsonResource[];
}

function toResource(value: unknown): JsonResource | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') {
    return undefined;
  }
  return {
    id: value.id,
    attributes: isRecord(value.attributes) ? value.attributes : {},
    ...(value.relationships === undefined ? {} : { relationships: value.relationships }),
  };
}

function relationshipId(relationships: unknown, name: string): string | undefined {
  if (!isRecord(relationships)) {
    return undefined;
  }
  const relationship = relationships[name];
  if (!isRecord(relationship) || !isRecord(relationship.data)) {
    return undefined;
  }
  return typeof relationship.data.id === 'string' ? relationship.data.id : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`asc output has no ${label}.`);
  }
  return value;
}

function optionalString<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  const result: Partial<Record<K, string>> = {};
  if (typeof value === 'string' && value !== '') {
    result[key] = value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
