import typia from 'typia';

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

  return manifest;
}
