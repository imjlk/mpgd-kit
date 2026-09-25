import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { inspectIosDistributionProfile } from './ios-signing-profile.js';

const certificate = Buffer.from('throwaway Apple distribution certificate');
const teamId = 'A1B2C3D4E5';
const bundleId = 'dev.mpgd.game';
const certificateSha256 = createHash('sha256').update(certificate).digest('hex').toUpperCase();
const input = {
  teamId,
  bundleId,
  certificateSha256,
  now: new Date('2026-01-01T00:00:00Z'),
};
const profile = {
  UUID: '12345678-ABCD-4ABC-ABCD-123456789ABC',
  Name: 'MPGD App Store',
  ExpirationDate: '2027-01-01T00:00:00Z',
  TeamIdentifier: [teamId],
  ApplicationIdentifierPrefix: [teamId],
  Entitlements: {
    'application-identifier': `${teamId}.${bundleId}`,
    'com.apple.developer.team-identifier': teamId,
    'get-task-allow': false,
  },
  DeveloperCertificates: [certificate.toString('base64')],
};

assert.deepEqual(inspectIosDistributionProfile(profile, input), {
  uuid: profile.UUID,
  name: profile.Name,
  expiresAt: profile.ExpirationDate,
});
const legacyPrefix = 'Z9Y8X7W6V5';
assert.deepEqual(inspectIosDistributionProfile({
  ...profile,
  ApplicationIdentifierPrefix: [legacyPrefix],
  Entitlements: {
    ...profile.Entitlements,
    'application-identifier': `${legacyPrefix}.${bundleId}`,
  },
}, input).uuid, profile.UUID);
assert.throws(
  () => inspectIosDistributionProfile({ ...profile, ApplicationIdentifierPrefix: [] }, input),
  /App ID prefix/u,
);
assert.throws(
  () => inspectIosDistributionProfile(profile, { ...input, teamId: 'BBBBBBBBBB' }),
  /signing team/u,
);
assert.throws(
  () => inspectIosDistributionProfile(profile, { ...input, bundleId: 'dev.mpgd.other' }),
  /app ID/u,
);
const wrongCertificate = { ...input, certificateSha256: 'F'.repeat(64) };
assert.throws(
  () => inspectIosDistributionProfile(profile, wrongCertificate),
  /signing certificate/u,
);
assert.throws(
  () => inspectIosDistributionProfile({ ...profile, ExpirationDate: '2025-01-01T00:00:00Z' }, input),
  /expired/u,
);
assert.throws(
  () => inspectIosDistributionProfile({ ...profile, ProvisionedDevices: ['device-id'] }, input),
  /not an App Store distribution profile/u,
);
const debugProfile = {
  ...profile,
  Entitlements: { ...profile.Entitlements, 'get-task-allow': true },
};
assert.throws(() => inspectIosDistributionProfile(debugProfile, input), /distribution rights/u);
console.info('iOS distribution profile preflight passed.');
