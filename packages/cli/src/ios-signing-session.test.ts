import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { prepareIosSigningSession, withIosSigningSession } from './ios-signing-session.js';

if (process.platform !== 'darwin') {
  console.info('iOS signing session smoke requires macOS.');
  process.exit(0);
}

const fixture = mkdtempSync(path.join(tmpdir(), 'mpgd-ios-session-test-'));
const certificate = path.join(fixture, 'certificate.pem');
const certificateDer = path.join(fixture, 'certificate.der');
const privateKey = path.join(fixture, 'private-key.pem');
const p12File = path.join(fixture, 'signing.p12');
const profilePlist = path.join(fixture, 'profile.plist');
const profileFile = path.join(fixture, 'profile.mobileprovision');
const profiles = path.join(fixture, 'profiles');
const password = randomBytes(24).toString('hex');
const uuid = '12345678-ABCD-4ABC-ABCD-123456789ABC';
const teamId = 'A1B2C3D4E5';
const bundleId = 'dev.mpgd.throwaway';

function run(command: string, args: readonly string[], environment = process.env): string {
  const result = spawnSync(command, [...args], {
    cwd: fixture,
    env: environment,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}

try {
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=mpgd-throwaway-session',
    '-keyout',
    privateKey,
    '-out',
    certificate,
  ]);
  run('openssl', ['x509', '-in', certificate, '-outform', 'DER', '-out', certificateDer]);
  run(
    'openssl',
    [
      'pkcs12',
      '-export',
      '-in',
      certificate,
      '-inkey',
      privateKey,
      '-out',
      p12File,
      '-passout',
      'env:MPGD_TEST_P12_PASSWORD',
    ],
    { ...process.env, MPGD_TEST_P12_PASSWORD: password },
  );
  const encodedCertificate = readFileSync(certificateDer).toString('base64');
  writeFileSync(profilePlist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>UUID</key><string>${uuid}</string>
<key>Name</key><string>MPGD Throwaway App Store</string>
<key>ExpirationDate</key><date>2030-01-01T00:00:00Z</date>
<key>TeamIdentifier</key><array><string>${teamId}</string></array>
<key>Entitlements</key><dict>
<key>application-identifier</key><string>${teamId}.${bundleId}</string>
<key>com.apple.developer.team-identifier</key><string>${teamId}</string>
<key>get-task-allow</key><false/>
</dict>
<key>DeveloperCertificates</key><array><data>${encodedCertificate}</data></array>
</dict></plist>\n`);
  run('openssl', [
    'cms',
    '-sign',
    '-binary',
    '-nodetach',
    '-in',
    profilePlist,
    '-signer',
    certificate,
    '-inkey',
    privateKey,
    '-outform',
    'DER',
    '-out',
    profileFile,
  ]);
  const originalSearchList = run('security', ['list-keychains', '-d', 'user']);
  const input = {
    p12File,
    p12Password: password,
    provisioningProfileFile: profileFile,
    bundleId,
    teamId,
    temporaryParent: fixture,
    provisioningProfilesDirectory: profiles,
  };
  const session = await prepareIosSigningSession(input);
  assert.equal(session.profileUuid, uuid);
  assert.equal(existsSync(session.keychainFile), true);
  assert.equal(existsSync(path.join(profiles, `${uuid}.mobileprovision`)), true);
  assert.match(readFileSync(session.exportOptionsPlist, 'utf8'), /app-store-connect/u);
  assert.equal(session.environment.MPGD_IOS_SIGNING_P12_PASSWORD, undefined);
  assert.match(session.environment.MPGD_IOS_SIGNING_IDENTITY ?? '', /^[0-9A-F]{40}$/u);
  assert.equal(run('security', ['list-keychains', '-d', 'user']), originalSearchList);
  session.dispose();
  session.dispose();
  assert.equal(existsSync(session.keychainFile), false);
  assert.equal(existsSync(path.join(profiles, `${uuid}.mobileprovision`)), false);
  await assert.rejects(
    withIosSigningSession(input, async () => {
      throw new Error('cancelled build');
    }),
    /cancelled build/u,
  );
  assert.equal(existsSync(path.join(profiles, `${uuid}.mobileprovision`)), false);
  await assert.rejects(
    withIosSigningSession(input, async (active) => {
      const dispose = active.dispose.bind(active);
      active.dispose = () => {
        dispose();
        throw new Error('simulated cleanup failure');
      };
      throw new Error('simulated build failure');
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors.length === 2
      && String(error.errors[0]).includes('simulated build failure')
      && String(error.errors[1]).includes('simulated cleanup failure'),
  );
  assert.equal(existsSync(path.join(profiles, `${uuid}.mobileprovision`)), false);
  const conflictingProfile = path.join(profiles, `${uuid}.mobileprovision`);
  writeFileSync(conflictingProfile, 'existing profile belongs to the game');
  await assert.rejects(prepareIosSigningSession(input), /same UUID but different bytes/u);
  assert.equal(readFileSync(conflictingProfile, 'utf8'), 'existing profile belongs to the game');
  rmSync(conflictingProfile);
  await assert.rejects(
    prepareIosSigningSession({ ...input, p12Password: 'wrong' }),
    /identity import failed/u,
  );
  assert.equal(existsSync(path.join(profiles, `${uuid}.mobileprovision`)), false);
  console.info('Isolated iOS signing session and cleanup passed with throwaway material.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
