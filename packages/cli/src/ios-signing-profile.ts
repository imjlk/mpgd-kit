import { createHash } from 'node:crypto';

export interface IosDistributionProfile {
  readonly uuid: string;
  readonly name: string;
  readonly expiresAt: string;
}

const profileUuidPattern = /^[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}$/iu;
const certFingerprintPattern = /^[0-9A-F]{64}$/u;

/** Preflight only: the signed archive and IPA are still inspected after Xcode export. */
export function inspectIosDistributionProfile(
  value: unknown,
  input: {
    readonly bundleId: string;
    readonly teamId: string;
    readonly certificateSha256: string;
    readonly now?: Date;
  },
): IosDistributionProfile {
  if (!isRecord(value)) {
    throw new Error('iOS provisioning profile is malformed.');
  }
  const uuid = value.UUID;
  const name = value.Name;
  const expiresAt = value.ExpirationDate;
  const expiration = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  if (typeof uuid !== 'string' || !profileUuidPattern.test(uuid)
    || typeof name !== 'string' || name.trim() === ''
    || typeof expiresAt !== 'string'
    || !Number.isFinite(expiration) || expiration <= (input.now ?? new Date()).getTime()) {
    throw new Error('iOS provisioning profile is malformed or expired.');
  }
  if (!/^[A-Z0-9]{10}$/u.test(input.teamId)
    || !certFingerprintPattern.test(input.certificateSha256)
    || !Array.isArray(value.TeamIdentifier)
    || !value.TeamIdentifier.includes(input.teamId)) {
    throw new Error('iOS provisioning profile does not match the signing team.');
  }
  if (!isRecord(value.Entitlements)
    || value.Entitlements['application-identifier'] !== `${input.teamId}.${input.bundleId}`
    || value.Entitlements['get-task-allow'] === true
    || (value.Entitlements['com.apple.developer.team-identifier'] !== undefined
      && value.Entitlements['com.apple.developer.team-identifier'] !== input.teamId)) {
    throw new Error('iOS provisioning profile does not match the app ID or distribution rights.');
  }
  if (!Array.isArray(value.DeveloperCertificates)
    || !value.DeveloperCertificates.some((certificate) => {
      if (typeof certificate !== 'string' || certificate === '') {
        return false;
      }
      const observed = createHash('sha256')
        .update(Buffer.from(certificate, 'base64'))
        .digest('hex')
        .toUpperCase();
      return observed === input.certificateSha256;
    })) {
    throw new Error('iOS provisioning profile does not contain the signing certificate.');
  }
  if (value.ProvisionsAllDevices === true
    || (Array.isArray(value.ProvisionedDevices) && value.ProvisionedDevices.length > 0)) {
    throw new Error('iOS provisioning profile is not an App Store distribution profile.');
  }
  return { uuid, name, expiresAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
