import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { AscCredential } from './app-store-iap-asc.js';
import { planNativeDeployment } from './deploy-planning.js';
import { readStoreCredential } from './native-deploy-run.js';

/**
 * What every `mpgd store <kind> plan|apply` shares: the app and credential
 * the deployment profile names, the saved plan file, the stable digests
 * apply compares, and moving a reviewed plan to another checkout.
 */

export type StoreSyncStore = 'google-play' | 'app-store';

/** The store app the deployment profile names, with its credential. */
export type StoreSyncApp =
  | {
      readonly store: 'google-play';
      readonly packageName: string;
      readonly serviceAccountFile: string;
    }
  | {
      readonly store: 'app-store';
      /** Numeric App Store Connect app ID. */
      readonly appId: string;
      readonly bundleId: string;
      readonly credential: AscCredential;
    };

/**
 * Resolve the app and credential of `store` from the game's deployment
 * profile, the same ones `deploy submit` uses.
 */
export function resolveStoreSyncApp(
  options: { readonly game: string; readonly profile: string; readonly store: StoreSyncStore },
  environment: NodeJS.ProcessEnv,
): StoreSyncApp {
  assertStoreSyncStore(options.store);
  const target = options.store === 'google-play' ? 'android' : 'ios';
  const deployment = planNativeDeployment({
    game: path.resolve(options.game),
    profile: options.profile,
    targets: [target],
  });
  const planned = deployment.targets.find((entry) => entry.target === target);
  if (planned === undefined) {
    throw new Error(`Deployment profile ${options.profile} has no ${target} target.`);
  }
  const credential = readStoreCredential(deployment, target, environment);
  if (credential.target === 'android') {
    return {
      store: 'google-play',
      packageName: planned.appId,
      serviceAccountFile: credential.serviceAccountFile,
    };
  }
  return {
    store: 'app-store',
    appId: credential.appStoreAppId,
    bundleId: planned.appId,
    credential: {
      ascBinary: credential.ascBinary,
      apiKeyId: credential.apiKeyId,
      apiIssuerId: credential.apiIssuerId,
      apiPrivateKeyBase64: credential.apiPrivateKeyBase64,
    },
  };
}

export function assertStoreSyncStore(store: string): asserts store is StoreSyncStore {
  if (store !== 'google-play' && store !== 'app-store') {
    throw new Error('--store must be google-play or app-store.');
  }
}

/**
 * A file a saved plan read, moved to the game directory apply runs in
 * (`apply --game`). Files outside the saved game directory cannot move.
 */
export function relocateStoreSyncFile(
  savedGameRoot: string,
  gameRoot: string | undefined,
  file: string,
): string {
  if (gameRoot === undefined) {
    return file;
  }
  const relative = path.relative(savedGameRoot, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `The saved plan reads ${file}, outside its game directory; --game cannot move it. Plan again.`,
    );
  }
  return path.resolve(gameRoot, relative);
}

/** JSON with object keys sorted, so equal values always hash the same. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function stableSha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** A new plan file, never overwriting one (the same rule as `deploy plan --out`). */
export function writeStorePlanFile(file: string, plan: unknown): string {
  const resolved = path.resolve(file);
  writeFileSync(resolved, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return resolved;
}

/** A saved plan's top-level object; the caller checks its fields. */
export function readStorePlanFile(file: string, label: string): Record<string, unknown> {
  const raw = readJsonFile(path.resolve(file));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Saved ${label} is malformed.`);
  }
  return raw as Record<string, unknown>;
}

/** The store or the game files moved past the reviewed plan. */
export class StorePlanStaleError extends Error {
  constructor(detail: string, planCommand: string) {
    super(`${detail} Run "${planCommand}" again and review the new plan.`);
    this.name = 'StorePlanStaleError';
  }
}

/** BCP-47 casing: language lowercase, script title case, region uppercase. */
export function canonicalLanguageTag(tag: string): string {
  return tag.split('-').map((part, index) => {
    if (index === 0) {
      return part.toLowerCase();
    }
    if (/^[A-Za-z]{4}$/u.test(part)) {
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`;
    }
    if (/^[A-Za-z]{2}$/u.test(part)) {
      return part.toUpperCase();
    }
    return part.toLowerCase();
  }).join('-');
}

/** `map` with at most `limit` calls in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
