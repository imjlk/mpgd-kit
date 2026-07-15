import { Verse8 } from '@verse8/platform/vanilla';

import {
  createUnsupportedCapabilities,
  type IdentitySession,
  type PlatformGateway,
  type PlayerIdentity,
} from '@mpgd/platform';

export interface Verse8Credential {
  readonly account: `0x${string}`;
  readonly verse: string;
  readonly exp: number;
}

export interface Verse8AuthClient {
  getUser(options?: { readonly requireTrustedSigner?: boolean }): Verse8Credential;
}

export interface Verse8Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Verse8VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', callback: () => void): void;
  removeEventListener(type: 'visibilitychange', callback: () => void): void;
}

export interface Verse8PlatformGatewayOptions {
  readonly authClient?: Verse8AuthClient;
  readonly storage?: Verse8Storage;
  readonly visibility?: Verse8VisibilitySource;
}

interface ResolvedVerse8Identity {
  readonly player: PlayerIdentity | null;
  readonly session: IdentitySession;
}

export function createVerse8PlatformGateway(
  options: Verse8PlatformGatewayOptions = {},
): PlatformGateway {
  const authClient = options.authClient ?? createDefaultAuthClient();
  const pauseListeners = new Set<() => void>();
  const resumeListeners = new Set<() => void>();
  const visibility = options.visibility ?? resolveVisibilitySource();
  const onVisibilityChange = () => {
    const listeners = visibility?.hidden === true ? pauseListeners : resumeListeners;

    for (const listener of listeners) {
      listener();
    }
  };

  visibility?.addEventListener('visibilitychange', onVisibilityChange);

  return {
    target: 'verse8',
    async getCapabilities() {
      return {
        ...createUnsupportedCapabilities(),
        localizedContent: true,
      };
    },
    identity: {
      async getPlayer() {
        return resolveVerse8Identity(authClient).player;
      },
      async getSession() {
        return resolveVerse8Identity(authClient).session;
      },
    },
    commerce: {
      async getProducts() {
        return [];
      },
      async purchase() {
        return {
          status: 'failed',
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
          submitted: false,
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
        const storage = options.storage ?? resolveStorage();
        const value = storage?.getItem(storageKey(input.key));

        return value === undefined || value === null
          ? null
          : { value: JSON.parse(value) as unknown };
      },
      async save(input) {
        const storage = options.storage ?? resolveStorage();
        storage?.setItem(storageKey(input.key), JSON.stringify(input.value));
      },
    },
    presentation: {
      async getLaunchIntent() {
        return {
          entry: 'home',
        };
      },
      async requestGameSurface() {
        return 'already-fullscreen';
      },
    },
  };
}

function createDefaultAuthClient(): Verse8AuthClient {
  return {
    getUser(options) {
      return Verse8.getUser(options);
    },
  };
}

function resolveVerse8Identity(authClient: Verse8AuthClient): ResolvedVerse8Identity {
  try {
    const credential = authClient.getUser({ requireTrustedSigner: true });

    return createResolvedIdentity(credential, 'authenticated', 'server-verified');
  } catch {
    try {
      const credential = authClient.getUser();

      return createResolvedIdentity(credential, 'platform-anonymous', 'platform-asserted');
    } catch {
      return {
        player: null,
        session: {
          identityLevel: 'guest',
          trustLevel: 'local',
        },
      };
    }
  }
}

function createResolvedIdentity(
  credential: Verse8Credential,
  identityLevel: IdentitySession['identityLevel'],
  trustLevel: IdentitySession['trustLevel'],
): ResolvedVerse8Identity {
  return {
    player: {
      playerId: credential.account,
    },
    session: {
      identityLevel,
      playerId: credential.account,
      trustLevel,
    },
  };
}

function storageKey(key: string): string {
  return `mpgd:verse8:${key}`;
}

function resolveStorage(): Verse8Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function resolveVisibilitySource(): Verse8VisibilitySource | undefined {
  return typeof document === 'undefined' ? undefined : document;
}
