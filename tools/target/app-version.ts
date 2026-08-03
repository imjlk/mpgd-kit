import { createMpgdReleaseIdentity } from '@mpgd/target-config';

export function requireCanonicalAppVersion(value: string): string {
  const gameVersion = createMpgdReleaseIdentity({ gameVersion: value }).gameVersion;

  if (value !== gameVersion) {
    throw new TypeError('APP_VERSION must be canonical without leading or trailing whitespace.');
  }

  return gameVersion;
}
