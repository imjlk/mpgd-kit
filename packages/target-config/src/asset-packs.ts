/** Provider-neutral locations for non-executable asset-pack payloads. */
export type AssetPackLocation = 'packaged' | 'remote';

export interface AssetPackDeliveryPolicy {
  readonly defaultLocation: AssetPackLocation;
  readonly packs?: Readonly<Record<string, AssetPackLocation>>;
  /** These packs and their dependency closure must work on first launch offline. */
  readonly offlineRequired?: readonly string[];
  /** HTTPS directory URL; HTTP is accepted only for loopback development. */
  readonly remoteBaseUrl?: string;
  /** Total packaged asset namespace, including manifest and policy metadata. */
  readonly maxPackagedBytes?: number;
}

export interface AssetPackTargetPolicy extends AssetPackDeliveryPolicy {
  /** Build config path relative to mpgd.targets.json. No credentials belong here. */
  readonly buildConfig: string;
}

export interface AssetPackPolicyPack {
  readonly packId: string;
  readonly revision: string;
  readonly dependencies: readonly { readonly packId: string; readonly revision: string }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertAssetPackDeliveryPolicy(input: unknown): asserts input is AssetPackDeliveryPolicy {
  if (!record(input) || (input.defaultLocation !== 'packaged' && input.defaultLocation !== 'remote')) {
    throw new Error('assetPacks.defaultLocation must be packaged or remote');
  }
  const keys = new Set([
    'buildConfig',
    'defaultLocation',
    'packs',
    'offlineRequired',
    'remoteBaseUrl',
    'maxPackagedBytes',
  ]);
  if (Object.keys(input).some((key) => !keys.has(key))) {
    throw new Error(
      'assetPacks contains an unknown field; credentials are not target configuration',
    );
  }
  if (input.packs !== undefined) {
    if (!record(input.packs) || Object.keys(input.packs).length > 4096) {
      throw new Error('assetPacks.packs must be a bounded pack-location map');
    }
    for (const [id, location] of Object.entries(input.packs)) {
      if (!id || (location !== 'packaged' && location !== 'remote')) {
        throw new Error('assetPacks.packs contains an invalid pack location');
      }
    }
  }
  if (input.offlineRequired !== undefined && (!Array.isArray(input.offlineRequired)
    || input.offlineRequired.length > 4096
    || input.offlineRequired.some((id: unknown) => typeof id !== 'string' || !id))) {
    throw new Error('assetPacks.offlineRequired must be a bounded list of pack IDs');
  }
  if (input.maxPackagedBytes !== undefined && (!Number.isSafeInteger(input.maxPackagedBytes)
    || (input.maxPackagedBytes as number) <= 0)) {
    throw new Error('assetPacks.maxPackagedBytes must be a positive safe integer');
  }
  if (input.remoteBaseUrl !== undefined) {
    if (typeof input.remoteBaseUrl !== 'string') {
      throw new Error('assetPacks.remoteBaseUrl must be a directory URL');
    }
    const url = new URL(input.remoteBaseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
      throw new Error(
        'assetPacks.remoteBaseUrl requires an HTTPS directory URL without credentials, query or fragment (HTTP loopback allowed)',
      );
    }
  }
}

export function assertAssetPackTargetPolicy(input: unknown): asserts input is AssetPackTargetPolicy {
  assertAssetPackDeliveryPolicy(input);
  const buildConfig = (input as unknown as Record<string, unknown>).buildConfig;
  if (typeof buildConfig !== 'string' || !buildConfig.trim()) {
    throw new Error('assetPacks.buildConfig must be a non-empty path');
  }
}

/** Resolve the offline dependency closure; explicit remote conflicts fail closed. */
export function resolveAssetPackLocations(
  policy: AssetPackDeliveryPolicy,
  packs: readonly AssetPackPolicyPack[],
): Readonly<Record<string, AssetPackLocation>> {
  assertAssetPackDeliveryPolicy(policy);
  const byId = new Map(packs.map((pack) => [pack.packId, pack]));
  if (byId.size !== packs.length || packs.length > 4096) {
    throw new Error('Asset pack policy requires unique, bounded pack IDs');
  }
  const locations: Record<string, AssetPackLocation> = Object.create(
    null,
  ) as Record<string, AssetPackLocation>;
  for (const pack of packs) {
    locations[pack.packId] = policy.packs && Object.hasOwn(policy.packs, pack.packId)
      ? policy.packs[pack.packId]! : policy.defaultLocation;
    for (const dependency of pack.dependencies) {
      if (byId.get(dependency.packId)?.revision !== dependency.revision) {
        throw new Error(`Unknown dependency revision in pack ${pack.packId}`);
      }
    }
  }
  for (const id of Object.keys(policy.packs ?? {})) {
    if (!byId.has(id)) {
      throw new Error(`Unknown asset pack override: ${id}`);
    }
  }
  const pending = [...(policy.offlineRequired ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) {
      continue;
    }
    const pack = byId.get(id);
    if (!pack) {
      throw new Error(`Unknown offline-required asset pack: ${id}`);
    }
    if (policy.packs && Object.hasOwn(policy.packs, id) && policy.packs[id] === 'remote') {
      throw new Error(`Offline-required dependency ${id} is explicitly remote`);
    }
    visited.add(id);
    locations[id] = 'packaged';
    pending.push(...pack.dependencies.map((dependency) => dependency.packId));
  }
  if (Object.values(locations).includes('remote') && policy.remoteBaseUrl === undefined) {
    throw new Error('Remote asset packs require assetPacks.remoteBaseUrl');
  }
  return Object.freeze(locations);
}

/** Compatible with Phaser delivery's resolveURL; its path is already encoded once. */
export function createAssetPackTargetURLResolver(
  policy: AssetPackDeliveryPolicy,
  packs: readonly AssetPackPolicyPack[],
  packagedBaseUrl: string,
): (encodedPath: string, context: { readonly packId: string; readonly revision: string }) => string {
  const locations = resolveAssetPackLocations(policy, packs);
  const revisions = new Map(packs.map((pack) => [pack.packId, pack.revision]));
  const local = new URL(packagedBaseUrl);
  if (!local.pathname.endsWith('/') || local.username || local.password || local.search || local.hash) {
    throw new Error('Packaged asset base must be a directory URL');
  }
  const remote = policy.remoteBaseUrl;
  return (encodedPath, context) => {
    if (revisions.get(context.packId) !== context.revision) {
      throw new Error('Asset URL context does not match the selected pack revision');
    }
    if (!encodedPath || encodedPath.startsWith('/') || /[?#:\\]/.test(encodedPath)
      || encodedPath.split('/').some((part) => !part || ['.', '..'].includes(decodeURIComponent(part))
        || /[/\\]/.test(decodeURIComponent(part)))) {
      throw new Error('Asset URL requires an encoded relative artifact path');
    }
    return new URL(encodedPath, locations[context.packId] === 'remote' ? remote! : local).href;
  };
}
