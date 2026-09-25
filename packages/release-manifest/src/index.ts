import typia from 'typia';

import {
  createMpgdReleaseIdentity,
  formatMpgdReleaseId,
  type MpgdReleaseIdentity,
} from '@mpgd/target-config';

export interface ReleaseNativeDelivery {
  readonly platform: 'android' | 'ios';
  readonly mode: 'sync' | 'debug' | 'simulator' | 'unsigned-archive'
    | 'signed-archive' | 'store-export';
  readonly signed: boolean;
  /** Candidate for store submission; not proof of store acceptance. */
  readonly submissionCandidate: boolean;
}

export interface ReleaseTargetManifest {
  readonly artifact: string;
  readonly profile?: string;
  readonly effectiveConfig: {
    readonly path: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly iconManifest: {
    readonly path: string;
    readonly digest: string;
    readonly sourceSha256: string;
    readonly sharedConfigSha256: string;
    readonly renderConfigSha256: string;
    readonly generatorVersion: string;
    readonly targetProfile: string;
    readonly targetProfileVersion: string;
  };
  readonly versionName?: string;
  readonly versionCode?: number;
  readonly marketingVersion?: string;
  readonly buildNumber?: string;
  readonly nativeDelivery?: ReleaseNativeDelivery;
  readonly appName?: string;
  readonly sdkMajor?: number;
}

export interface ReleaseManifest {
  readonly releaseId: string;
  /** Revision of the downstream game source used for this build. */
  readonly gitSha: string;
  /** Revision of mpgd-kit that generated the target artifacts. */
  readonly kitGitSha: string;
  readonly gameVersion: string;
  /**
   * Optional for backwards compatibility with manifests produced before the
   * shared release-revision contract existed.
   */
  readonly releaseIdentity?: MpgdReleaseIdentity;
  readonly buildId: string;
  readonly targetConfigVersion: string;
  readonly catalogVersion: string;
  readonly adPlacementVersion: string;
  readonly targets: Record<string, ReleaseTargetManifest>;
}

const assertReleaseManifestStructure = typia.createAssert<ReleaseManifest>();
const fullGitShaPattern = /^[0-9a-f]{40}$/u;

export function assertReleaseManifest(input: unknown): ReleaseManifest {
  const manifest = assertReleaseManifestStructure(input);

  for (const [target, entry] of Object.entries(manifest.targets)) {
    const delivery = entry.nativeDelivery;
    if (delivery === undefined) {
      continue;
    }
    const validPlatformMode = delivery.platform === 'android'
      ? ['debug', 'unsigned-archive', 'signed-archive'].includes(delivery.mode)
      : ['sync', 'simulator', 'unsigned-archive', 'signed-archive', 'store-export']
        .includes(delivery.mode);
    const expectedSigned = delivery.mode === 'signed-archive'
      || delivery.mode === 'store-export';
    const expectedCandidate = entry.profile === 'production' && (delivery.platform === 'android'
      ? delivery.mode === 'signed-archive'
      : delivery.mode === 'store-export');
    if (!validPlatformMode || delivery.signed !== expectedSigned
      || delivery.submissionCandidate !== expectedCandidate) {
      throw new TypeError(`Release manifest native delivery state is inconsistent: ${target}.`);
    }
    if (entry.profile === 'production' && !delivery.signed) {
      throw new TypeError(`Release manifest production native delivery is unsigned: ${target}.`);
    }
  }

  if (!fullGitShaPattern.test(manifest.kitGitSha)) {
    throw new TypeError('Release manifest kitGitSha must be a lowercase 40-character SHA.');
  }

  if (manifest.releaseIdentity !== undefined) {
    const releaseIdentity = createMpgdReleaseIdentity({
      gameVersion: manifest.releaseIdentity.gameVersion,
      ...(manifest.releaseIdentity.releaseRevision === undefined
        ? {}
        : { releaseRevision: manifest.releaseIdentity.releaseRevision }),
      expectedLabel: manifest.releaseIdentity.label,
    });

    if (manifest.releaseIdentity.label !== releaseIdentity.label) {
      throw new TypeError(
        'Release manifest releaseIdentity.label must be canonical without whitespace.',
      );
    }

    if (manifest.releaseIdentity.gameVersion !== releaseIdentity.gameVersion) {
      throw new TypeError(
        'Release manifest releaseIdentity.gameVersion must be canonical without whitespace.',
      );
    }

    if (manifest.gameVersion !== releaseIdentity.gameVersion) {
      throw new TypeError('Release manifest gameVersion must match releaseIdentity.gameVersion.');
    }

    if (manifest.releaseId !== formatMpgdReleaseId(releaseIdentity.label, manifest.buildId)) {
      throw new TypeError('Release manifest releaseId must include the release identity label.');
    }
  }

  return manifest;
}
