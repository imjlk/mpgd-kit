import { createBridgeError, type BridgeRequest, type BridgeResponse } from '@mpgd/bridge';
import type { StorageAdapter } from '@mpgd/platform';
import {
  runStorageAdapterConformance,
  storageAdapterConformanceScenarios,
  type StorageAdapterConformanceFixture,
  type StorageAdapterConformanceReport,
} from '@mpgd/platform/storage-conformance';

import { createAitPlatformGateway, type GamePlatformBridge } from '../../adapters/ait/src/index';
import { createBrowserPlatformGateway } from '../../adapters/browser/src/index';
import {
  createCapacitorPlatformGateway,
  type NativeBridge,
} from '../../adapters/capacitor/src/index';
import { createDevvitPlatformGateway, type DevvitBridge } from '../../adapters/devvit/src/index';
import {
  createVerse8Agent8StorageService,
  type Verse8Agent8PrivateStorageCodec,
  type Verse8Agent8StateContext,
} from '../../adapters/verse8/src/agent8-services';
import {
  createVerse8PlatformGateway,
  type Verse8AuthClient,
  type Verse8Storage,
} from '../../adapters/verse8/src/index';

const maximumValueBytes = 256;
const oversizedValue = 'x'.repeat(maximumValueBytes * 2);
type BridgeTarget = 'android' | 'ios' | 'ait' | 'reddit';
type StorageConformanceBridge = NativeBridge & GamePlatformBridge & DevvitBridge;

const targets = [
  ['web-preview-local', createBrowserFixture],
  ['microsoft-store-local', createBrowserFixture],
  ['android-js-bridge-boundary', () => createBridgeFixture('android')],
  ['ios-js-bridge-boundary', () => createBridgeFixture('ios')],
  ['ait-bridge', () => createBridgeFixture('ait')],
  ['reddit-devvit-remote', () => createBridgeFixture('reddit')],
  ['verse8-local', createVerse8LocalFixture],
  ['verse8-agent8-remote', createVerse8Agent8Fixture],
] as const;

for (const [name, createFixture] of targets) {
  let report: StorageAdapterConformanceReport;

  try {
    report = await runStorageAdapterConformance({ createFixture });
  } catch (error) {
    const message = `Storage adapter target conformance failed: ${name}. ${errorDetails(error)}`;
    throw new Error(message, { cause: error });
  }

  assertJsonEqual(
    report.passedScenarios,
    storageAdapterConformanceScenarios,
    `${name} must pass every storage conformance scenario`,
  );
}

console.log(
  `Storage adapter conformance passed for ${String(targets.length)} local and remote target fixtures.`,
);

function createBrowserFixture(): StorageAdapterConformanceFixture {
  const provider = createStringStorageProvider();
  const primary = createBrowserPlatformGateway({
    storage: provider.storage('primary-browser-profile', true),
  });
  const isolated = createBrowserPlatformGateway({
    storage: provider.storage('isolated-browser-profile', false),
  });

  return createFixture(primary.storage, isolated.storage, provider.faults);
}

function createVerse8LocalFixture(): StorageAdapterConformanceFixture {
  const provider = createStringStorageProvider();
  const deviceStorage = provider.storage('verse8-device', true);
  const primary = createVerse8PlatformGateway({
    authClient: createVerse8AuthClient('0xprimary'),
    storage: deviceStorage,
  });
  const isolated = createVerse8PlatformGateway({
    authClient: createVerse8AuthClient('0xisolated'),
    storage: deviceStorage,
  });

  return createFixture(primary.storage, isolated.storage, provider.faults);
}

function createBridgeFixture(target: BridgeTarget): StorageAdapterConformanceFixture {
  const provider = createBridgeStorageProvider(target === 'reddit');
  const primary = createBridgeStorage(target, provider.bridge('primary-account', true));
  const isolated = createBridgeStorage(target, provider.bridge('isolated-account', false));

  return createFixture(primary, isolated, provider.faults);
}

function createBridgeStorage(
  target: BridgeTarget,
  bridge: StorageConformanceBridge,
): StorageAdapter {
  const metadata = {
    appVersion: '1.0.0',
    buildId: 'storage-conformance',
  } as const;

  if (target === 'android' || target === 'ios') {
    return createCapacitorPlatformGateway({
      target,
      ...metadata,
      bridge,
    }).storage;
  }

  if (target === 'ait') {
    return createAitPlatformGateway({ ...metadata, bridge }).storage;
  }

  return createDevvitPlatformGateway({ ...metadata, bridge }).storage;
}

function createVerse8Agent8Fixture(): StorageAdapterConformanceFixture {
  const state = new Map<string, Readonly<Record<string, unknown>>>();
  let failNextSave = false;
  let failNextLoad = false;
  const context: Verse8Agent8StateContext = {
    async getUserState(account) {
      if (account === '0xprimary' && failNextLoad) {
        failNextLoad = false;
        throw new Error('simulated Agent8 load failure');
      }

      return clone(state.get(account) ?? {});
    },
    async updateUserState(account, patch) {
      if (account === '0xprimary' && failNextSave) {
        failNextSave = false;
        throw new Error('simulated Agent8 save failure');
      }

      const next = { ...state.get(account), ...clone(patch) };
      state.set(account, next);
      return clone(next);
    },
    async lock(_key, callback) {
      return callback();
    },
  };
  const service = createVerse8Agent8StorageService({
    codec: createConformanceCodec(),
    persistenceSecret: 'storage-conformance-persistence-secret-32-bytes',
    stateNamespace: 'storageConformance',
    maximumEntries: 32,
    maximumValueBytes,
    maximumStateBytes: 4_096,
  });
  const primary = createAgent8StorageAdapter('0xprimary', service, context);
  const isolated = createAgent8StorageAdapter('0xisolated', service, context);

  return {
    storage: primary,
    isolatedStorage: isolated,
    oversizedValue,
    armNextSaveFailure() {
      assert(!failNextSave, 'an Agent8 save failure is already armed');
      failNextSave = true;
    },
    armNextLoadFailure() {
      assert(!failNextLoad, 'an Agent8 load failure is already armed');
      failNextLoad = true;
    },
  };
}

function createAgent8StorageAdapter(
  account: string,
  service: ReturnType<typeof createVerse8Agent8StorageService>,
  context: Verse8Agent8StateContext,
): StorageAdapter {
  return {
    load: (input) => service.load(account, input, context),
    save: (input) => service.save(account, input, context),
  };
}

function createConformanceCodec(): Verse8Agent8PrivateStorageCodec {
  // Deterministic conformance double only. Production Agent8 integrations must
  // supply game-owned authenticated encryption with server-only keys.
  return {
    security: 'authenticated-encryption',
    async seal(input) {
      return {
        keyId: 'storage-conformance-key',
        ciphertext: JSON.stringify(input),
      };
    },
    async open({ account, key, envelope }) {
      const decoded = JSON.parse(envelope.ciphertext) as {
        readonly account: string;
        readonly key: string;
        readonly value: unknown;
      };
      assert(decoded.account === account, 'the Agent8 envelope account must match');
      assert(decoded.key === key, 'the Agent8 envelope key must match');
      return clone(decoded.value);
    },
  };
}

function createVerse8AuthClient(account: `0x${string}`): Verse8AuthClient {
  return {
    getUser() {
      return {
        account,
        verse: 'storage-conformance',
        exp: 4_102_444_800,
      };
    },
  };
}

function createFixture(
  storage: StorageAdapter,
  isolatedStorage: StorageAdapter,
  faults: FaultController,
): StorageAdapterConformanceFixture {
  return {
    storage,
    isolatedStorage,
    oversizedValue,
    armNextSaveFailure: faults.armNextSaveFailure,
    armNextLoadFailure: faults.armNextLoadFailure,
  };
}

interface FaultController {
  readonly armNextSaveFailure: () => void;
  readonly armNextLoadFailure: () => void;
}

function createStringStorageProvider(): {
  readonly storage: (
    scope: string,
    controlled: boolean,
  ) => Pick<Storage, 'getItem' | 'setItem'> & Verse8Storage;
  readonly faults: FaultController;
} {
  const scopes = new Map<string, Map<string, string>>();
  let failNextSave = false;
  let failNextLoad = false;

  const getScope = (scope: string): Map<string, string> => {
    const existing = scopes.get(scope);

    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<string, string>();
    scopes.set(scope, created);
    return created;
  };

  return {
    storage(scope, controlled) {
      return {
        getItem(key) {
          if (controlled && failNextLoad) {
            failNextLoad = false;
            throw new Error('simulated local storage load failure');
          }

          return getScope(scope).get(key) ?? null;
        },
        setItem(key, value) {
          if (controlled && failNextSave) {
            failNextSave = false;
            throw new Error('simulated local storage save failure');
          }

          if (utf8Bytes(value) > maximumValueBytes) {
            throw new Error('simulated local storage quota rejection');
          }

          getScope(scope).set(key, value);
        },
      };
    },
    faults: {
      armNextSaveFailure() {
        assert(!failNextSave, 'a local save failure is already armed');
        failNextSave = true;
      },
      armNextLoadFailure() {
        assert(!failNextLoad, 'a local load failure is already armed');
        failNextLoad = true;
      },
    },
  };
}

function createBridgeStorageProvider(devvitSaveAcknowledgment: boolean): {
  readonly bridge: (scope: string, controlled: boolean) => StorageConformanceBridge;
  readonly faults: FaultController;
} {
  const scopes = new Map<string, Map<string, unknown>>();
  let failNextSave = false;
  let failNextLoad = false;

  const getScope = (scope: string): Map<string, unknown> => {
    const existing = scopes.get(scope);

    if (existing !== undefined) {
      return existing;
    }

    const created = new Map<string, unknown>();
    scopes.set(scope, created);
    return created;
  };

  return {
    bridge(scope, controlled) {
      return {
        async request(input) {
          const payload = readStoragePayload(input);

          if (input.method === 'storage.load') {
            if (controlled && failNextLoad) {
              failNextLoad = false;
              return createBridgeError(
                input.id,
                'SIMULATED_STORAGE_LOAD_FAILURE',
                'Simulated storage load failure.',
                true,
              );
            }

            const value = getScope(scope).get(payload.key);
            return ok(
              input,
              value === undefined
                ? { found: false }
                : { found: true, value: clone(value) },
            );
          }

          if (input.method === 'storage.save') {
            if (controlled && failNextSave) {
              failNextSave = false;
              return createBridgeError(
                input.id,
                'SIMULATED_STORAGE_SAVE_FAILURE',
                'Simulated storage save failure.',
                true,
              );
            }

            if (utf8Bytes(JSON.stringify(payload.value)) > maximumValueBytes) {
              return createBridgeError(
                input.id,
                'SIMULATED_STORAGE_QUOTA_EXCEEDED',
                'Simulated storage quota rejection.',
              );
            }

            getScope(scope).set(payload.key, clone(payload.value));
            return ok(input, devvitSaveAcknowledgment ? { saved: true } : {});
          }

          return createBridgeError(
            input.id,
            'UNSUPPORTED_CONFORMANCE_METHOD',
            `Unsupported storage conformance method: ${input.method}`,
          );
        },
      };
    },
    faults: {
      armNextSaveFailure() {
        assert(!failNextSave, 'a bridge save failure is already armed');
        failNextSave = true;
      },
      armNextLoadFailure() {
        assert(!failNextLoad, 'a bridge load failure is already armed');
        failNextLoad = true;
      },
    },
  };
}

function readStoragePayload(input: BridgeRequest): {
  readonly key: string;
  readonly value: unknown;
} {
  assert(typeof input.payload === 'object' && input.payload !== null, 'payload must be an object');
  const payload = input.payload as { readonly key?: unknown; readonly value?: unknown };
  assert(typeof payload.key === 'string', 'storage payload key must be a string');
  return { key: payload.key, value: payload.value };
}

function ok(input: BridgeRequest, data: unknown): BridgeResponse {
  return { id: input.id, ok: true, data };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;
  return cause === undefined ? error.message : `${error.message} ${errorDetails(cause)}`;
}
