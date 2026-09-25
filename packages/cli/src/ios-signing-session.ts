import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runReleaseProcess } from './deploy-process.js';
import { parseIosProfilePlist } from './ios-plist.js';
import { inspectIosDistributionProfile } from './ios-signing-profile.js';

export interface IosSigningSessionInput {
  readonly p12File: string;
  readonly p12Password: string;
  readonly provisioningProfileFile: string;
  readonly bundleId: string;
  readonly teamId: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly temporaryParent?: string;
  readonly provisioningProfilesDirectory?: string;
}

export interface IosSigningSession {
  readonly environment: NodeJS.ProcessEnv;
  readonly certificateSha256: string;
  readonly keychainFile: string;
  readonly profileUuid: string;
  readonly exportOptionsPlist: string;
  dispose(): void;
}

const certificatePattern = /^[0-9A-F]{64}$/u;
const identityPattern = /^[0-9A-F]{40}$/u;
const maximumCredentialBytes = 64 * 1024 * 1024;

/** Import one identity into an owned keychain and pair it with an App Store profile. */
export async function prepareIosSigningSession(
  input: IosSigningSessionInput,
): Promise<IosSigningSession> {
  if (process.platform !== 'darwin') {
    throw new Error('iOS signing sessions require macOS.');
  }
  if (input.p12Password === '' || !/^[A-Z0-9]{10}$/u.test(input.teamId)
    || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(input.bundleId)) {
    throw new Error('iOS signing requires a P12 password, team ID and explicit bundle ID.');
  }
  const p12File = requiredCredentialFile(input.p12File, 'iOS P12');
  const profileFile = requiredCredentialFile(input.provisioningProfileFile, 'iOS profile');
  const ownedRoot = mkdtempSync(path.join(input.temporaryParent ?? tmpdir(), 'mpgd-ios-signing-'));
  const keychainFile = path.join(ownedRoot, 'signing.keychain-db');
  const decodedProfile = path.join(ownedRoot, 'profile.plist');
  const decodedXml = path.join(ownedRoot, 'profile.xml');
  const exportOptionsPlist = path.join(ownedRoot, 'ExportOptions.plist');
  const keychainPassword = randomBytes(32).toString('hex');
  const environment: NodeJS.ProcessEnv = {
    ...(input.environment ?? process.env),
    MPGD_IOS_SESSION_KEYCHAIN: keychainFile,
    MPGD_IOS_SESSION_KEYCHAIN_PASSWORD: keychainPassword,
    MPGD_IOS_SIGNING_P12: p12File,
    MPGD_IOS_SIGNING_P12_PASSWORD: input.p12Password,
    MPGD_IOS_TEAM_ID: input.teamId,
    MPGD_IOS_SIGNING_STYLE: 'Manual',
    MPGD_IOS_EXPORT_OPTIONS_PLIST: exportOptionsPlist,
  };
  let installedProfile: { readonly path: string; readonly sha256: string } | undefined;
  try {
    chmodSync(ownedRoot, 0o700);
    const helper = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'ios-keychain-import.swift',
    );
    if (!existsSync(helper)) {
      throw new Error('The installed CLI is missing its iOS signing helper.');
    }
    const imported = await runReleaseProcess({
      command: 'swift',
      args: [helper],
      cwd: ownedRoot,
      environment,
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024,
      captureMachineStdout: true,
      signal: input.signal,
    });
    const identity = JSON.parse(imported.machineStdout ?? '') as {
      certificateSha256?: unknown;
      certificateSha1?: unknown;
    };
    const certificateSha256 = identity.certificateSha256;
    const certificateSha1 = identity.certificateSha1;
    if (imported.truncated || typeof certificateSha256 !== 'string'
      || !certificatePattern.test(certificateSha256)
      || typeof certificateSha1 !== 'string' || !identityPattern.test(certificateSha1)) {
      throw new Error('iOS signing identity helper returned an invalid certificate fingerprint.');
    }
    await runReleaseProcess({
      command: 'security',
      args: ['cms', '-D', '-i', profileFile, '-o', decodedProfile],
      cwd: ownedRoot,
      environment,
      timeoutMs: 30_000,
      signal: input.signal,
    });
    await runReleaseProcess({
      command: 'plutil',
      args: ['-convert', 'xml1', '-o', decodedXml, decodedProfile],
      cwd: ownedRoot,
      environment,
      timeoutMs: 30_000,
      signal: input.signal,
    });
    const profile = inspectIosDistributionProfile(
      parseIosProfilePlist(readFileSync(decodedXml, 'utf8')),
      { bundleId: input.bundleId, teamId: input.teamId, certificateSha256 },
    );
    const profileDirectory = input.provisioningProfilesDirectory
      ?? path.join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');
    mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(profileDirectory, `${profile.uuid}.mobileprovision`);
    if (isSymlink(destination)) {
      throw new Error('The iOS provisioning profile destination must not be a symlink.');
    }
    if (existsSync(destination)) {
      if (!readFileSync(destination).equals(readFileSync(profileFile))) {
        throw new Error(
          'An existing iOS provisioning profile has the same UUID but different bytes.',
        );
      }
    } else {
      const profileSha256 = fileDigest(profileFile);
      copyFileSync(profileFile, destination, constants.COPYFILE_EXCL);
      installedProfile = { path: destination, sha256: profileSha256 };
      chmodSync(destination, 0o600);
    }
    writeFileSync(exportOptionsPlist, exportPlist(input.teamId, input.bundleId, profile.uuid), {
      mode: 0o600,
      flag: 'wx',
    });
    environment.MPGD_IOS_PROVISIONING_PROFILE_SPECIFIER = profile.uuid;
    environment.MPGD_IOS_SIGNING_IDENTITY = certificateSha1;
    environment.MPGD_IOS_SIGNING_KEYCHAIN = keychainFile;
    delete environment.MPGD_IOS_SIGNING_P12;
    delete environment.MPGD_IOS_SIGNING_P12_PASSWORD;
    delete environment.MPGD_IOS_SESSION_KEYCHAIN_PASSWORD;
    let disposed = false;
    return {
      environment,
      certificateSha256,
      keychainFile,
      profileUuid: profile.uuid,
      exportOptionsPlist,
      dispose(): void {
        if (disposed) {
          return;
        }
        removeOwnedSigningMaterial(ownedRoot, installedProfile);
        disposed = true;
      },
    };
  } catch (error) {
    try {
      removeOwnedSigningMaterial(ownedRoot, installedProfile);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'iOS signing setup and cleanup failed.');
    }
    throw error;
  }
}

/** Preserve build errors when temporary signing material cleanup also fails. */
export async function withIosSigningSession<T>(
  input: IosSigningSessionInput,
  action: (session: IosSigningSession) => Promise<T>,
): Promise<T> {
  const session = await prepareIosSigningSession(input);
  let outcome: { readonly ok: true; readonly value: T } | {
    readonly ok: false;
    readonly error: unknown;
  };
  try {
    outcome = { ok: true, value: await action(session) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    session.dispose();
  } catch (cleanupError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        'iOS signing build and cleanup both failed.',
      );
    }
    throw cleanupError;
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function removeOwnedSigningMaterial(
  root: string,
  profile: { readonly path: string; readonly sha256: string } | undefined,
): void {
  const errors: unknown[] = [];
  if (profile !== undefined) {
    try {
      if (existsSync(profile.path) || isSymlink(profile.path)) {
        if (isSymlink(profile.path) || fileDigest(profile.path) !== profile.sha256) {
          throw new Error('Owned iOS provisioning profile changed before cleanup.');
        }
        rmSync(profile.path);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'iOS signing cleanup failed.');
  }
}

function fileDigest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function requiredCredentialFile(file: string, label: string): string {
  const absolute = path.resolve(file);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw new Error(`${label} is missing or unreadable.`);
  }
  if (!stat.isFile() || stat.size < 1 || stat.size > maximumCredentialBytes) {
    throw new Error(`${label} must be a nonempty regular file under 64 MiB.`);
  }
  return absolute;
}

function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function exportPlist(teamId: string, bundleId: string, profileUuid: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>signingStyle</key><string>manual</string>
<key>teamID</key><string>${teamId}</string>
<key>provisioningProfiles</key><dict><key>${bundleId}</key><string>${profileUuid}</string></dict>
</dict></plist>\n`;
}
