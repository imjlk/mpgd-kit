import typia from 'typia';

import {
  createMpgdReleaseIdentity,
  formatMpgdReleaseId,
  type MpgdReleaseIdentity,
} from '@mpgd/target-config';

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

    if (manifest.gameVersion !== releaseIdentity.gameVersion) {
      throw new TypeError('Release manifest gameVersion must match releaseIdentity.gameVersion.');
    }

    if (manifest.releaseId !== formatMpgdReleaseId(releaseIdentity.label, manifest.buildId)) {
      throw new TypeError('Release manifest releaseId must include the release identity label.');
    }
  }

  return manifest;
}
