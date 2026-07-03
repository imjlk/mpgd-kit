import {
  createUnsupportedCapabilities,
  type PlatformGateway,
  type PlayerIdentity,
} from '@mpgd/platform-contract';

export function createBrowserPlatformGateway(): PlatformGateway {
  const pauseListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      const listeners = document.hidden ? pauseListeners : resumeListeners;

      for (const listener of listeners) {
        listener();
      }
    });
  }

  return {
    target: 'browser',
    async getCapabilities() {
      return {
        ...createUnsupportedCapabilities(),
        cloudSave: true,
      };
    },
    identity: {
      async getPlayer(): Promise<PlayerIdentity> {
        return {
          playerId: 'browser-player',
          displayName: 'Browser Player',
        };
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase() {
        return {
          status: 'cancelled',
          entitlementIds: [],
        };
      },
      async getEntitlements() {
        return [];
      },
    },
    ads: {
      async preload() {},
      async showRewarded() {
        return {
          status: 'unavailable',
          rewardGranted: false,
        };
      },
      async showInterstitial() {
        return {
          status: 'unavailable',
        };
      },
    },
    leaderboard: {
      async submitScore() {
        return {
          submitted: true,
        };
      },
      async open() {},
    },
    lifecycle: {
      onPause(callback) {
        pauseListeners.add(callback);
        return () => pauseListeners.delete(callback);
      },
      onResume(callback) {
        resumeListeners.add(callback);
        return () => resumeListeners.delete(callback);
      },
    },
    storage: {
      async load(input) {
        if (typeof localStorage === 'undefined') {
          return null;
        }

        const value = localStorage.getItem(`mpgd:${input.key}`);
        return value === null ? null : JSON.parse(value);
      },
      async save(input) {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(`mpgd:${input.key}`, JSON.stringify(input.value));
        }
      },
    },
  };
}
