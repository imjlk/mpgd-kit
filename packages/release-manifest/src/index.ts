import typia from 'typia';

export interface ReleaseTargetManifest {
  readonly artifact: string;
  readonly profile?: string;
  readonly versionName?: string;
  readonly versionCode?: number;
  readonly marketingVersion?: string;
  readonly buildNumber?: string;
  readonly appName?: string;
  readonly sdkMajor?: number;
}

export interface ReleaseManifest {
  readonly releaseId: string;
  readonly gitSha: string;
  readonly gameVersion: string;
  readonly buildId: string;
  readonly catalogVersion: string;
  readonly adPlacementVersion: string;
  readonly targets: Record<string, ReleaseTargetManifest>;
}

export const assertReleaseManifest = typia.createAssert<ReleaseManifest>();
