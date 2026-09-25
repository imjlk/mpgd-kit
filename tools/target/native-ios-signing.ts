import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export interface IosSigningPlan {
  readonly teamId: string;
  readonly archiveBuildSettings: readonly string[];
  readonly exportOptionsPlist?: string;
}

/** Signing identities live in the host keychain; no key material is copied. */
export function resolveIosSigningPlan(
  environment: NodeJS.ProcessEnv,
  mode: 'signed-archive' | 'store-export',
): IosSigningPlan {
  const teamId = environment.MPGD_IOS_TEAM_ID?.trim();
  if (teamId === undefined || !/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error('Signed iOS builds require a 10-character MPGD_IOS_TEAM_ID.');
  }
  const style = environment.MPGD_IOS_SIGNING_STYLE ?? 'Automatic';
  if (style !== 'Automatic' && style !== 'Manual') {
    throw new Error('MPGD_IOS_SIGNING_STYLE must be Automatic or Manual.');
  }
  const identity = environment.MPGD_IOS_SIGNING_IDENTITY?.trim();
  const profile = environment.MPGD_IOS_PROVISIONING_PROFILE_SPECIFIER?.trim();
  if (style === 'Manual' && (identity === undefined || identity === ''
    || profile === undefined || profile === '')) {
    throw new Error('Manual iOS signing requires host identity and provisioning profile names.');
  }
  if (style === 'Automatic' && profile !== undefined && profile !== '') {
    throw new Error('Automatic iOS signing must not set a manual provisioning profile.');
  }
  const archiveBuildSettings = [
    'CODE_SIGNING_ALLOWED=YES',
    `CODE_SIGN_STYLE=${style}`,
    `DEVELOPMENT_TEAM=${teamId}`,
    ...(identity === undefined || identity === '' ? [] : [`CODE_SIGN_IDENTITY=${identity}`]),
    ...(profile === undefined || profile === ''
      ? [] : [`PROVISIONING_PROFILE_SPECIFIER=${profile}`]),
  ];

  if (mode !== 'store-export') {
    return { teamId, archiveBuildSettings };
  }
  const configuredExportFile = environment.MPGD_IOS_EXPORT_OPTIONS_PLIST;
  if (configuredExportFile === undefined || configuredExportFile.trim() === '') {
    throw new Error('iOS store export requires MPGD_IOS_EXPORT_OPTIONS_PLIST.');
  }
  const exportOptionsPlist = path.resolve(configuredExportFile);
  if (!existsSync(exportOptionsPlist) || !statSync(exportOptionsPlist).isFile()) {
    throw new Error('iOS export options plist must be an existing host file.');
  }
  const method = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :method', exportOptionsPlist], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (method.error !== undefined || method.status !== 0
    || !['app-store', 'app-store-connect'].includes(method.stdout.trim())) {
    throw new Error('iOS export options must select an App Store distribution method.');
  }
  return { teamId, archiveBuildSettings, exportOptionsPlist };
}
