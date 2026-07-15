import { describe, expect, it } from 'vitest';

import {
  createVerse8PlatformGateway,
  type Verse8AuthClient,
  type Verse8VisibilitySource,
} from './index';

const credential = {
  account: '0x1234567890abcdef' as const,
  verse: 'production',
  exp: 4_000_000_000,
};

describe('adapter-verse8', () => {
  it('exposes only foundation capabilities', async () => {
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
    });

    await expect(gateway.getCapabilities()).resolves.toMatchObject({
      nativeIap: false,
      nativeAds: false,
      rewardedAds: false,
      interstitialAds: false,
      nativeLeaderboard: false,
      cloudSave: false,
      localizedContent: true,
    });
    expect(gateway.target).toBe('verse8');
    expect(gateway.sharing).toBeUndefined();
    expect(gateway.notifications).toBeUndefined();
  });

  it('maps Verse8 signer credentials to a server-verified identity', async () => {
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
    });

    await expect(gateway.identity.getPlayer()).resolves.toEqual({
      playerId: credential.account,
    });
    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'authenticated',
      playerId: credential.account,
      trustLevel: 'server-verified',
    });
  });

  it('maps a verified self-signed credential to platform-anonymous identity', async () => {
    const authClient: Verse8AuthClient = {
      getUser(options) {
        if (options?.requireTrustedSigner === true) {
          throw new Error('not signed by the trusted Verse8 signer');
        }

        return credential;
      },
    };
    const gateway = createVerse8PlatformGateway({ authClient });

    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'platform-anonymous',
      playerId: credential.account,
      trustLevel: 'platform-asserted',
    });
  });

  it('falls back to a local guest when the auth credential is unusable', async () => {
    const gateway = createVerse8PlatformGateway({
      authClient: {
        getUser() {
          throw new Error('missing auth token');
        },
      },
    });

    await expect(gateway.identity.getPlayer()).resolves.toBeNull();
    await expect(gateway.identity.getSession?.()).resolves.toEqual({
      identityLevel: 'guest',
      trustLevel: 'local',
    });
  });

  it('keeps commerce, ads, and leaderboard unavailable', async () => {
    const gateway = createVerse8PlatformGateway({ authClient: authenticatedClient() });

    await expect(
      gateway.commerce.purchase({
        productId: 'COINS_100',
        source: 'shop',
        idempotencyKey: 'purchase-1',
      }),
    ).resolves.toEqual({ status: 'failed', entitlementIds: [] });
    await expect(
      gateway.ads.showRewarded({
        placementId: 'CONTINUE_AFTER_FAIL',
        idempotencyKey: 'reward-1',
      }),
    ).resolves.toEqual({ status: 'unavailable', rewardGranted: false });
    await expect(
      gateway.leaderboard.submitScore({
        leaderboardId: 'default',
        score: 1,
        runId: 'run-1',
        submittedAt: new Date().toISOString(),
      }),
    ).resolves.toEqual({ submitted: false });
  });

  it('persists local data with a Verse8-specific namespace', async () => {
    const values = new Map<string, string>();
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      storage: {
        getItem(key) {
          return values.get(key) ?? null;
        },
        setItem(key, value) {
          values.set(key, value);
        },
      },
    });

    await gateway.storage.save({ key: 'save:v1', value: { coins: 25 } });

    expect(values.get('mpgd:verse8:save:v1')).toBe('{"coins":25}');
    await expect(gateway.storage.load({ key: 'save:v1' })).resolves.toEqual({
      value: { coins: 25 },
    });
  });

  it('translates iframe visibility changes into lifecycle events', () => {
    let listener: (() => void) | undefined;
    let hidden = false;
    const visibility: Verse8VisibilitySource = {
      get hidden() {
        return hidden;
      },
      addEventListener(_type, callback) {
        listener = callback;
      },
      removeEventListener() {},
    };
    const gateway = createVerse8PlatformGateway({
      authClient: authenticatedClient(),
      visibility,
    });
    const calls: string[] = [];

    gateway.lifecycle.onPause(() => calls.push('pause'));
    gateway.lifecycle.onResume(() => calls.push('resume'));
    hidden = true;
    listener?.();
    hidden = false;
    listener?.();

    expect(calls).toEqual(['pause', 'resume']);
  });
});

function authenticatedClient(): Verse8AuthClient {
  return {
    getUser() {
      return credential;
    },
  };
}
