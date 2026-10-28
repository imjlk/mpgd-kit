import type { PlatformGateway } from '@mpgd/platform';

import { createTestCommerceProvider, createTestGateway } from './commerce-test-provider.test.js';
import {
  createGameServicesRuntime,
  gameServicesBackendEndpoints,
  GameServicesBackendError,
  GameServicesBackendTransportError,
  GameServicesHeaderResolutionError,
  isPublicGameServicesUrl,
  resolveGameServicesAuthorityMode,
  resolveGameServicesBaseUrl,
  resolveGameServicesTransport,
  type GameServicesBackendApi,
  type GameServicesBackendTransportRequest,
  type MonetizationOperationRecord,
} from './index';
import { isMonetizationOperationRecoverable } from './monetization-operation-store.js';

const playerId = 'runtime-player';

for (const target of ['browser', 'microsoft-store'] as const) {
  for (const path of ['/api', '/api/game-services']) {
    const baseUrl = resolveGameServicesBaseUrl(path, {
      target,
      pageOrigin: 'https://game.example.com',
    });
    assertEqual(
      baseUrl,
      `https://game.example.com${path}`,
      'hosted URL resolves before runtime validation',
    );
    const runtime = createGameServicesRuntime({
      gateway: createGateway(target),
      playerId,
      authorityMode: 'production',
      ...(baseUrl === undefined ? {} : { baseUrl }),
    });
    assertEqual(
      runtime.mode,
      'http',
      'hosted relative configuration keeps authoritative runtime enabled',
    );
    assertEqual(runtime.baseUrl, baseUrl, 'all clients receive the resolved absolute base');
  }
}
for (const target of ['android', 'ios', 'ait', 'verse8'] as const) {
  assertEqual(
    resolveGameServicesBaseUrl('/api', { target, pageOrigin: 'https://game.example.com' }),
    '/api',
    'native relative configuration is not resolved',
  );
}
for (const path of [
  '//evil.example.com/api',
  '/\\evil.example.com',
  '/api/../admin',
  '/api/%2f%2fevil',
  '/api?x=1',
  '/api#x',
  '/api\n',
]) {
  const baseUrl = resolveGameServicesBaseUrl(path, {
    target: 'browser',
    pageOrigin: 'https://game.example.com',
  });
  assertEqual(
    isPublicGameServicesUrl(baseUrl ?? ''),
    false,
    'unsafe relative paths cannot carry credentials',
  );
}
for (const pageOrigin of [
  'https://user:secret@game.example.com',
  'https://game.example.com/path',
  'https://game.example.com?x=1',
  'null',
  'file://',
]) {
  assertEqual(
    resolveGameServicesBaseUrl('/api', { target: 'browser', pageOrigin }),
    '/api',
    'only an exact http(s) page origin resolves',
  );
}
assertEqual(
  resolveGameServicesBaseUrl('/api', { target: 'browser' }),
  '/api',
  'SSR cannot invent an origin',
);
assertEqual(
  resolveGameServicesBaseUrl('https://services.example.com', { target: 'android' }),
  'https://services.example.com',
  'native HTTPS remains unchanged',
);
// Unsafe or unrecognized paths are never resolved against the page origin.
for (const path of [
  ' /api',
  '/api ',
  '/api\t',
  '/api/game services',
  '/api/%2e%2e/admin',
  '/api/./game-services',
  '/api//evil.example.com',
  '/apiary',
  '/other',
  'api',
]) {
  assertEqual(
    resolveGameServicesBaseUrl(path, { target: 'browser', pageOrigin: 'https://game.example.com' })
      ?.startsWith('https://'),
    false,
    `unsafe relative path is not resolved: ${JSON.stringify(path)}`,
  );
}
// Unresolved relative values stay fail-closed: production disables the
// runtime, development throws; no default backend is substituted.
for (const [target, pageOrigin] of [
  ['android', 'https://game.example.com'],
  ['browser', undefined],
] as const) {
  const unresolved = resolveGameServicesBaseUrl('/api', {
    target,
    ...(pageOrigin === undefined ? {} : { pageOrigin }),
  });
  assertEqual(unresolved, '/api', `relative URL stays relative on ${target}`);
  const runtime = createGameServicesRuntime({
    gateway: createGateway(target),
    playerId,
    authorityMode: 'production',
    baseUrl: unresolved ?? '/api',
  });
  assertEqual(runtime.mode, 'disabled', `unresolved relative URL disables ${target}`);
  assertEqual(
    runtime.reason,
    'invalid_authoritative_backend',
    `unresolved relative URL reason on ${target}`,
  );
  assertEqual(runtime.client, undefined, `unresolved relative URL exposes no client on ${target}`);
}
assertThrows(
  () =>
    createGameServicesRuntime({
      gateway: createGateway('browser'),
      playerId,
      authorityMode: 'non-production',
      baseUrl: resolveGameServicesBaseUrl('/api', { target: 'browser' }) ?? '/api',
    }),
  'valid absolute URL',
  'development relative URL without a page origin should fail fast',
);
// An http page resolves to an http URL: production refuses it, development
// (a local dev server) keeps it.
{
  const httpBaseUrl = resolveGameServicesBaseUrl('/api', {
    target: 'browser',
    pageOrigin: 'http://game.example.com',
  });
  assertEqual(httpBaseUrl, 'http://game.example.com/api', 'http page origin resolves as http');
  assertEqual(
    isPublicGameServicesUrl(httpBaseUrl ?? ''),
    false,
    'http hosted URL cannot carry credentials',
  );
  const production = createGameServicesRuntime({
    gateway: createGateway('browser'),
    playerId,
    authorityMode: 'production',
    ...(httpBaseUrl === undefined ? {} : { baseUrl: httpBaseUrl }),
  });
  assertEqual(
    production.reason,
    'invalid_authoritative_backend',
    'production refuses an http page origin',
  );
  assertEqual(production.client, undefined, 'production http page origin exposes no client');
  const development = createGameServicesRuntime({
    gateway: createGateway('browser'),
    playerId,
    authorityMode: 'non-production',
    baseUrl: resolveGameServicesBaseUrl('/api', {
      target: 'browser',
      pageOrigin: 'http://localhost:5173',
    }) ?? '',
  });
  assertEqual(development.mode, 'http', 'development keeps a local http page origin');
  assertEqual(
    development.baseUrl,
    'http://localhost:5173/api',
    'development resolves against the dev server',
  );
}
let purchaseCalls = 0;
let rewardCalls = 0;
let leaderboardCalls = 0;
const localBackend = {
  purchases: {
    async verifyPurchase(input) {
      purchaseCalls += 1;

      return {
        verified: true,
        ledgerEntryId: `local-purchase-${input.idempotencyKey}`,
        alreadyProcessed: false,
      };
    },
  },
  adRewards: {
    async claimAdReward(input) {
      rewardCalls += 1;

      return {
        granted: true,
        ledgerEntryId: `local-reward-${input.idempotencyKey}`,
        alreadyProcessed: false,
      };
    },
  },
  leaderboard: {
    async recordScore(input) {
      leaderboardCalls += 1;

      return {
        submitted: true,
        ledgerEntryId: `local-score-${input.runId}`,
        alreadyProcessed: false,
        rank: 1,
      };
    },
  },
} satisfies GameServicesBackendApi;

const productionWithoutUrl = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'production',
  allowLocalBackend: true,
  localBackend,
});

assertEqual(productionWithoutUrl.mode, 'disabled', 'production without URL should disable');
assertEqual(
  productionWithoutUrl.reason,
  'missing_authoritative_backend',
  'production without URL should report the authoritative backend requirement',
);
assertEqual(productionWithoutUrl.client, undefined, 'production should not expose a local client');
assertLocalCalls(0, 'production factory creation');

const productionWithBlankUrl = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'production',
  baseUrl: '   ',
  allowLocalBackend: true,
  localBackend,
});

assertEqual(
  productionWithBlankUrl.reason,
  'missing_authoritative_backend',
  'blank production URL should remain fail-closed',
);
assertLocalCalls(0, 'blank production URL');

for (const baseUrl of [
  'not a URL',
  'http://services.example.com',
  'https://user:secret@services.example.com',
  'https://localhost:5173',
  'https://service.local',
  'https://10.0.0.1',
  'https://192.168.0.1',
  'https://[::1]',
  'https://[fc00::1]',
  'https://[::ffff:10.0.0.1]',
]) {
  const invalidProductionRuntime = createGameServicesRuntime({
    gateway: createGateway(),
    playerId,
    authorityMode: 'production',
    baseUrl,
    allowLocalBackend: true,
    localBackend,
  });

  assertEqual(
    invalidProductionRuntime.reason,
    'invalid_authoritative_backend',
    `production should reject ${baseUrl}`,
  );
  assertEqual(
    invalidProductionRuntime.client,
    undefined,
    `invalid production URL should not expose a client: ${baseUrl}`,
  );
}
assertLocalCalls(0, 'invalid production URLs');

const localDevelopmentUrl = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'non-production',
  baseUrl: 'http://localhost:5173',
});

assertEqual(
  localDevelopmentUrl.mode,
  'http',
  'non-production should permit an explicitly configured local HTTP service',
);

assertThrows(
  () =>
    createGameServicesRuntime({
      gateway: createGateway(),
      playerId,
      authorityMode: 'non-production',
      baseUrl: 'not a URL',
    }),
  'valid absolute URL',
  'non-production malformed URL should fail fast',
);
assertThrows(
  () =>
    createGameServicesRuntime({
      gateway: createGateway(),
      playerId,
      authorityMode: 'non-production',
      baseUrl: 'http://localhost:5173',
      transport: 'grpc' as never,
    }),
  'transport must be http or orpc',
  'invalid factory transport should fail fast',
);

const developmentWithoutOptIn = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'non-production',
  localBackend,
});

assertEqual(
  developmentWithoutOptIn.reason,
  'local_backend_not_allowed',
  'non-production local authority should require explicit opt-in',
);

assertEqual(
  resolveGameServicesAuthorityMode('production'),
  'production',
  'production profile should require authoritative services',
);
assertEqual(
  resolveGameServicesAuthorityMode('staging'),
  'non-production',
  'staging profile should use non-production authority policy',
);
assertEqual(
  resolveGameServicesAuthorityMode('development'),
  'non-production',
  'development profile should use non-production authority policy',
);
assertEqual(resolveGameServicesTransport(undefined), 'http', 'missing transport should use HTTP');
assertEqual(resolveGameServicesTransport('http'), 'http', 'HTTP transport should remain HTTP');
assertEqual(resolveGameServicesTransport('orpc'), 'orpc', 'oRPC transport should remain oRPC');
assertThrows(
  () => resolveGameServicesTransport('grpc'),
  'transport must be http or orpc',
  'unknown environment transport should fail fast',
);

const developmentWithoutBackend = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'non-production',
  allowLocalBackend: true,
});

assertEqual(
  developmentWithoutBackend.reason,
  'local_backend_unavailable',
  'local opt-in should still require an explicit backend',
);

const localRuntime = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'non-production',
  allowLocalBackend: true,
  localBackend,
  now: () => '2026-07-13T00:00:00.000Z',
});

assertEqual(localRuntime.mode, 'local', 'explicit non-production local backend should be enabled');

const localClient = requireValue(localRuntime.client, 'local runtime client');
const purchase = await localClient.purchase({
  productId: 'COINS_100',
  source: 'shop',
  idempotencyKey: 'runtime-purchase',
});
const reward = await localClient.claimRewardedAd({
  placementId: 'CONTINUE_AFTER_FAIL',
  idempotencyKey: 'runtime-reward',
});
const leaderboard = await localClient.submitLeaderboardScore({
  leaderboardId: 'default',
  score: 1200,
  runId: 'runtime-run',
  submittedAt: '2026-07-13T00:00:01.000Z',
});

assertEqual(purchase.status, 'granted', 'local purchase should work only after explicit opt-in');
assertEqual(reward.status, 'granted', 'local reward should work only after explicit opt-in');
assertEqual(leaderboard.submitted, true, 'local leaderboard should work after explicit opt-in');
assertLocalCalls(1, 'explicit non-production local client');

const recoveryRecords = new Map<string, MonetizationOperationRecord>();
let recoveryBackendCalls = 0;
const recoveryRuntime = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'non-production',
  allowLocalBackend: true,
  localBackend: {
    ...localBackend,
    purchases: {
      async verifyPurchase(request) {
        recoveryBackendCalls += 1;
        return {
          verified: true,
          ledgerEntryId: `recovery-${request.idempotencyKey}`,
          alreadyProcessed: recoveryBackendCalls > 1,
        };
      },
    },
  },
  operationStore: {
    async reserve(record) {
      const existing = recoveryRecords.get(record.key);
      if (existing !== undefined) {
        return { created: false, record: existing };
      }
      recoveryRecords.set(record.key, record);
      return { created: true, record };
    },
    async read(key) {
      return recoveryRecords.get(key);
    },
    async replace(expectedRevision, record) {
      const existing = recoveryRecords.get(record.key);
      if (existing?.revision !== expectedRevision) {
        throw new Error('stale monetization operation');
      }
      recoveryRecords.set(record.key, record);
    },
    async listRecoverable(owner) {
      return [...recoveryRecords.values()].filter((record) => record.playerId === owner
        && isMonetizationOperationRecoverable(record));
    },
  },
});
const recoveryClient = requireValue(recoveryRuntime.client, 'recoverable runtime client');
const recoveryOperation = {
  productId: 'COINS_100',
  source: 'shop' as const,
  idempotencyKey: 'runtime-recovery',
};
assertEqual(
  (await recoveryClient.purchase(recoveryOperation)).status,
  'granted',
  'first purchase should use the journal',
);
assertEqual(
  (await recoveryClient.purchase(recoveryOperation)).status,
  'granted',
  'repeat purchase should return the journaled result',
);
assertEqual(recoveryBackendCalls, 1, 'the runtime must route repeat purchases through its journal');
assertEqual(
  (await requireValue(recoveryRuntime.monetizationRecovery, 'recovery port').reconcile()).length,
  0,
  'runtime recovery should not scan terminal journal history',
);

const remoteRuntime = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'production',
  baseUrl: '  https://services.example.com/api/  ',
  allowLocalBackend: true,
  localBackend,
});

assertEqual(remoteRuntime.mode, 'http', 'production URL should select the remote HTTP backend');
assertEqual(
  remoteRuntime.baseUrl,
  'https://services.example.com/api/',
  'remote URL should be normalized',
);
assertEqual(remoteRuntime.target, 'android', 'runtime should preserve the ledger target');
assertNotEqual(remoteRuntime.client, undefined, 'remote production should expose a client');
assertLocalCalls(1, 'remote production factory creation');

const customRequests: GameServicesBackendTransportRequest[] = [];
let currentAuthorization = 'Bearer first';
let failCustomRequest = false;
let throwCustomRequest = false;
let malformedCustomResponse = false;
let unexpectedFetchCalls = 0;
const originalCustomFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
try {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async () => {
      unexpectedFetchCalls += 1;
      throw new Error('Default fetch must not run when an HTTP transport is injected.');
    },
  });
  const httpTransport = {
    async send(request: GameServicesBackendTransportRequest) {
      customRequests.push(request);
      if (throwCustomRequest) {
        throw new Error('Native SDK request included a secret header.');
      }
      return {
        status: malformedCustomResponse ? Number.NaN : failCustomRequest ? 503 : 200,
        body: failCustomRequest
          ? { code: 'unavailable' }
          : request.endpoint === gameServicesBackendEndpoints.claimAdReward
            ? { granted: true, ledgerEntryId: 'custom-reward-ledger', alreadyProcessed: false }
            : { verified: true, ledgerEntryId: 'custom-ledger', alreadyProcessed: false },
      };
    },
  };
  const customRuntime = createGameServicesRuntime({
    gateway: createGateway(),
    playerId,
    authorityMode: 'production',
    baseUrl: 'https://services.example.com',
    httpTransport,
    headers: { Authorization: 'Bearer stale', 'x-game-target': 'android' },
    getHeaders: () => ({ authorization: currentAuthorization }),
  });
  const customClient = requireValue(customRuntime.client, 'custom transport client');
  const first = await customClient.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'custom-first',
  });
  assertEqual(first.status, 'granted', 'custom HTTP transport should reach the backend API');
  currentAuthorization = 'Bearer refreshed';
  const second = await customClient.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'custom-second',
  });
  assertEqual(second.status, 'granted', 'custom HTTP transport should remain selected');
  // A purchase reads the backend capabilities once when the reconciler starts,
  // verifies once, and reads ledger status; only the verify request is a grant.
  const verifyRequests = (): GameServicesBackendTransportRequest[] => customRequests.filter(
    (request) => request.endpoint === gameServicesBackendEndpoints.verifyPurchase,
  );
  assertEqual(verifyRequests().length, 2, 'each purchase should make exactly one verify request');
  assertEqual(
    customRequests[0]?.headers?.authorization,
    'Bearer first',
    'the first request should use its current authorization',
  );
  assertEqual(
    Object.keys(customRequests[0]?.headers ?? {}).filter((name) => name.toLowerCase() === 'authorization').length,
    1,
    'custom transport must receive only one canonical authorization header',
  );
  assertEqual(
    verifyRequests()[1]?.headers?.authorization,
    'Bearer refreshed',
    'the next request should resolve refreshed authorization',
  );
  assertEqual(
    verifyRequests()[1]?.headers?.['x-game-target'],
    'android',
    'custom transport should receive static backend headers',
  );
  assertEqual(unexpectedFetchCalls, 0, 'custom HTTP transport must not call default fetch');

  const headerFailureRuntime = createGameServicesRuntime({
    gateway: createGateway(),
    playerId,
    authorityMode: 'production',
    baseUrl: 'https://services.example.com',
    httpTransport,
    getHeaders: () => {
      throw new Error('Bearer secret-refresh-token');
    },
  });
  const sentBeforeHeaderFailure = customRequests.length;
  try {
    await requireValue(headerFailureRuntime.client, 'header failure client').claimRewardedAd({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: 'header-failure',
    });
    throw new Error('Failed header resolution unexpectedly sent a request.');
  } catch (error) {
    if (!(error instanceof GameServicesHeaderResolutionError)
      || error.message.includes('secret-refresh-token')) {
      throw error;
    }
  }
  assertEqual(
    customRequests.length,
    sentBeforeHeaderFailure,
    'header failure must not dispatch an uncertain backend operation',
  );
  assertEqual(unexpectedFetchCalls, 0, 'header failure must not use fallback fetch');

  failCustomRequest = true;
  // The reconciler keeps a purchase whose backend answer failed open: the
  // saved verify request is resent later, and nothing is granted meanwhile.
  const outagePurchase = await customClient.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'custom-outage',
  });
  assertEqual(outagePurchase.status, 'pending', 'a backend outage leaves the purchase pending');
  assertEqual(outagePurchase.ledgerEntryId, undefined, 'a backend outage grants nothing');
  try {
    await customClient.claimRewardedAd({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: 'custom-failure',
    });
    throw new Error('Custom backend failure unexpectedly succeeded.');
  } catch (error) {
    if (!(error instanceof GameServicesBackendError) || error.status !== 503) {
      throw error;
    }
  }
  assertEqual(unexpectedFetchCalls, 0, 'failed custom requests must not fall back to fetch');

  failCustomRequest = false;
  throwCustomRequest = true;
  try {
    await customClient.claimRewardedAd({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: 'custom-throw',
    });
    throw new Error('Thrown custom transport failure unexpectedly succeeded.');
  } catch (error) {
    if (!(error instanceof GameServicesBackendTransportError)
      || error.message.includes('secret header')) {
      throw error;
    }
  }
  throwCustomRequest = false;
  malformedCustomResponse = true;
  try {
    await customClient.claimRewardedAd({
      placementId: 'CONTINUE_AFTER_FAIL',
      idempotencyKey: 'custom-malformed',
    });
    throw new Error('Malformed custom transport response unexpectedly succeeded.');
  } catch (error) {
    if (!(error instanceof GameServicesBackendTransportError)) {
      throw error;
    }
  }
  malformedCustomResponse = false;
  assertEqual(unexpectedFetchCalls, 0, 'transport failures must not fall back to fetch');

  const sentBeforeRejectedProduction = customRequests.length;
  const rejectedProduction = createGameServicesRuntime({
    gateway: createGateway(),
    playerId,
    authorityMode: 'production',
    baseUrl: 'http://localhost:5173',
    httpTransport,
  });
  assertEqual(
    rejectedProduction.reason,
    'invalid_authoritative_backend',
    'custom transport must not bypass production base URL validation',
  );
  assertEqual(
    customRequests.length,
    sentBeforeRejectedProduction,
    'invalid production runtime must not invoke transport',
  );
  assertThrows(
    () =>
      createGameServicesRuntime({
        gateway: createGateway(),
        playerId,
        authorityMode: 'non-production',
        httpTransport,
      }),
    'requires an authoritative baseUrl',
    'custom HTTP transport should not silently select a local backend',
  );
  assertThrows(
    () => createGameServicesRuntime({
      gateway: createGateway(), playerId, authorityMode: 'production',
      baseUrl: 'https://services.example.com/rpc', transport: 'orpc',
      httpTransport,
    } as never),
    'cannot be used with oRPC',
    'JSON HTTP transport must not masquerade as oRPC fetch',
  );
} finally {
  if (originalCustomFetch === undefined) {
    Reflect.deleteProperty(globalThis, 'fetch');
  } else {
    Object.defineProperty(globalThis, 'fetch', originalCustomFetch);
  }
}

const microsoftStoreRuntime = createGameServicesRuntime({
  gateway: createGateway('microsoft-store'),
  playerId,
  authorityMode: 'production',
  baseUrl: 'https://services.example.com/api',
});

assertEqual(
  microsoftStoreRuntime.mode,
  'http',
  'Microsoft Store should resolve an authoritative Game Services runtime',
);
assertEqual(
  microsoftStoreRuntime.target,
  'microsoft-store',
  'Microsoft Store should preserve its ledger target',
);
assertNotEqual(
  microsoftStoreRuntime.client,
  undefined,
  'Microsoft Store should expose the authoritative client',
);

const orpcRuntime = createGameServicesRuntime({
  gateway: createGateway(),
  playerId,
  authorityMode: 'production',
  baseUrl: 'https://services.example.com/rpc',
  transport: 'orpc',
});

assertEqual(orpcRuntime.mode, 'orpc', 'oRPC transport should select the oRPC backend');
assertNotEqual(orpcRuntime.client, undefined, 'oRPC production should expose a client');

const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
let observedRuntimeHeaders: Headers | undefined;
let rotatingHeader = 'Bearer initial';
try {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedRuntimeHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          verified: true,
          ledgerEntryId: 'runtime-header-ledger',
          alreadyProcessed: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const headerRuntime = createGameServicesRuntime({
    gateway: createGateway(),
    playerId,
    authorityMode: 'production',
    baseUrl: 'https://services.example.com',
    headers: {
      'x-ttokdoku-player-key': 'ait-player-key',
      'x-ttokdoku-target': 'ait',
    },
    getHeaders: () => ({ authorization: rotatingHeader }),
  });
  const headerClient = requireValue(headerRuntime.client, 'header runtime client');
  await headerClient.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'runtime-header-purchase',
  });
  assertEqual(
    observedRuntimeHeaders?.get('x-ttokdoku-player-key'),
    'ait-player-key',
    'remote runtimes should forward configured authoritative identity headers',
  );
  assertEqual(
    observedRuntimeHeaders?.get('x-ttokdoku-target'),
    'ait',
    'remote runtimes should forward configured target headers',
  );
  assertEqual(
    observedRuntimeHeaders?.get('authorization'),
    'Bearer initial',
    'default HTTP should resolve authorization when sending',
  );
  rotatingHeader = 'Bearer refreshed';
  await headerClient.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'runtime-header-refresh',
  });
  assertEqual(
    observedRuntimeHeaders?.get('authorization'),
    'Bearer refreshed',
    'default HTTP should refresh authorization per request',
  );

  observedRuntimeHeaders = undefined;
  const orpcHeaderRuntime = createGameServicesRuntime({
    gateway: createGateway(),
    playerId,
    authorityMode: 'production',
    baseUrl: 'https://services.example.com/rpc',
    transport: 'orpc',
    headers: {
      'x-ttokdoku-player-key': 'ait-player-key',
      'x-ttokdoku-target': 'ait',
    },
    getHeaders: () => ({ authorization: rotatingHeader }),
  });
  const orpcHeaderClient = requireValue(orpcHeaderRuntime.client, 'oRPC header runtime client');
  await orpcHeaderClient.purchase({
    productId: 'COINS_100',
    source: 'shop',
    idempotencyKey: 'runtime-orpc-header-purchase',
  }).catch(() => {
    // The test transport returns the HTTP backend response shape. The request
    // still proves that the oRPC link forwards authoritative headers.
  });
  assertEqual(
    readObservedRuntimeHeader(observedRuntimeHeaders, 'x-ttokdoku-player-key'),
    'ait-player-key',
    'oRPC runtimes should forward configured authoritative identity headers',
  );
  assertEqual(
    readObservedRuntimeHeader(observedRuntimeHeaders, 'x-ttokdoku-target'),
    'ait',
    'oRPC runtimes should forward configured target headers',
  );
  assertEqual(
    readObservedRuntimeHeader(observedRuntimeHeaders, 'authorization'),
    'Bearer refreshed',
    'oRPC should resolve authorization when sending',
  );
  rotatingHeader = 'Bearer rpc-rotated';
  observedRuntimeHeaders = undefined;
  await orpcHeaderClient.purchase({
    productId: 'COINS_100', source: 'shop', idempotencyKey: 'runtime-orpc-header-refresh',
  }).catch(() => {
    // The HTTP-shaped fixture response still does not implement oRPC.
  });
  assertEqual(
    readObservedRuntimeHeader(observedRuntimeHeaders, 'authorization'),
    'Bearer rpc-rotated',
    'oRPC should refresh authorization per request',
  );
} finally {
  if (originalFetchDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, 'fetch');
  } else {
    Object.defineProperty(globalThis, 'fetch', originalFetchDescriptor);
  }
}

const unsupportedRuntime = createGameServicesRuntime({
  gateway: createGateway('telegram'),
  playerId,
  authorityMode: 'production',
  baseUrl: 'https://services.example.com',
});

assertEqual(unsupportedRuntime.mode, 'disabled', 'unsupported targets should be disabled');
assertEqual(
  unsupportedRuntime.reason,
  'unsupported_target',
  'unsupported targets should report their reason',
);

// The production URL rule the starter's notifications wiring shares with commerce.
for (const accepted of [
  'https://services.example',
  'https://services.example/api/',
  ' https://8.8.8.8 ',
]) {
  if (!isPublicGameServicesUrl(accepted)) {
    throw new Error(`isPublicGameServicesUrl refused ${accepted}.`);
  }
}
for (const refused of [
  'http://services.example',
  'https://user:pw@services.example',
  'https://localhost',
  'https://localhost.',
  'https://game.local',
  'https://127.0.0.1',
  'https://10.0.0.5',
  'https://192.168.1.2',
  'https://169.254.169.254',
  'https://[::1]',
  'https://[fd00::1]',
  'https://[::ffff:7f00:1]',
  'https://[::ffff:10.0.0.1]',
  'https://a.localhost',
  'not a url',
  '',
]) {
  if (isPublicGameServicesUrl(refused)) {
    throw new Error(`isPublicGameServicesUrl accepted ${refused}.`);
  }
}

console.log('GameServices runtime authority smoke test passed.');

// Account deletion rides the runtime's authoritative URL and headers.
{
  const remote = createGameServicesRuntime({
    gateway: createGateway(),
    playerId,
    authorityMode: 'production',
    baseUrl: 'https://game-services.example/',
    getHeaders: () => ({ authorization: 'Bearer runtime-session' }),
  });
  const deletion = requireValue(remote.accountDeletion, 'remote runtime account deletion');
  const realFetch = globalThis.fetch;
  const seen: { url: string; authorization: string | undefined }[] = [];
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, authorization: init.headers.authorization });
    return new Response(JSON.stringify({
      status: 'deleted',
      deletionId: 'deletion-1',
      completedAt: '2026-10-25T00:00:00.000Z',
      retainedPurchaseRecords: 0,
    }));
  }) as unknown as typeof fetch;
  try {
    assertEqual((await deletion.deleteAccount()).status, 'deleted', 'runtime account deletion');
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEqual(
    seen[0]?.url,
    'https://game-services.example/game-services/account/delete',
    'deletion URL',
  );
  assertEqual(seen[0]?.authorization, 'Bearer runtime-session', 'deletion header');
  // An oRPC runtime's URL names the `/rpc` handler; the route sits beside it.
  const orpc = createGameServicesRuntime({
    gateway: createGateway(),
    playerId,
    authorityMode: 'production',
    baseUrl: 'https://game-services.example/rpc',
    transport: 'orpc',
    getHeaders: () => ({ authorization: 'Bearer runtime-session' }),
  });
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, authorization: init.headers.authorization });
    return new Response(JSON.stringify({
      status: 'deleted',
      deletionId: 'deletion-2',
      completedAt: '2026-10-25T00:00:00.000Z',
      retainedPurchaseRecords: 0,
    }));
  }) as unknown as typeof fetch;
  try {
    await requireValue(orpc.accountDeletion, 'oRPC runtime account deletion').deleteAccount();
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEqual(
    seen[1]?.url,
    'https://game-services.example/game-services/account/delete',
    'oRPC deletion URL',
  );
  assertEqual(
    createGameServicesRuntime({
      gateway: createGateway(),
      playerId,
      authorityMode: 'non-production',
      allowLocalBackend: true,
      localBackend,
    }).accountDeletion,
    undefined,
    'a local backend has no account deletion',
  );
}

function createGateway(target: PlatformGateway['target'] = 'android'): PlatformGateway {
  return createTestGateway({
    target,
    playerId,
    provider: createTestCommerceProvider({ store: `${target}-store` }),
  });
}

function assertLocalCalls(expected: number, label: string): void {
  assertEqual(purchaseCalls, expected, `${label} purchase calls`);
  assertEqual(rewardCalls, expected, `${label} reward calls`);
  assertEqual(leaderboardCalls, expected, `${label} leaderboard calls`);
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label}.`);
  }

  return value;
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertNotEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    throw new Error(`${message}: did not expect ${String(expected)}.`);
  }
}

function readObservedRuntimeHeader(
  headers: Headers | undefined,
  name: string,
): string | null | undefined {
  return headers?.get(name);
}

function assertThrows(
  callback: () => unknown,
  expectedMessage: string,
  message: string,
): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }

    throw error;
  }

  throw new Error(`${message}: expected an error containing ${expectedMessage}.`);
}
