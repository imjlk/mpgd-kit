import typia from 'typia';

export interface ReleaseTargetManifest {
  readonly artifact: string;
  readonly profile?: string;
  readonly effectiveConfig: {
    readonly path: string;
    readonly version: string;
    readonly digest: string;
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

export const assertReleaseManifest = typia.createAssert<ReleaseManifest>();
