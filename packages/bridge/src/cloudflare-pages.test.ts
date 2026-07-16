import {
  createMpgdCloudflarePagesHostFetchHandler,
  defaultCloudflarePagesBridgeEndpoint,
  defaultCloudflarePagesGameServicesPrefix,
  type CloudflarePagesAssetsBinding,
  type CloudflarePagesServiceBinding,
  type MpgdCloudflarePagesHostEnv,
} from './cloudflare-pages';
import type { BridgeRequest, BridgeResponse } from './index';
import { createBridgeOrpcClient, defaultBridgeRpcEndpoint } from './orpc';

const baseUrl = 'https://pages-host.test';
const gameServicesRequests: { readonly path: string; readonly headers: Headers }[] = [];
const env = {
  ASSETS: createAssetBinding(),
  GAME_SERVICES: createGameServicesBinding(gameServicesRequests),
} satisfies MpgdCloudflarePagesHostEnv;
const fetchHandler = createMpgdCloudflarePagesHostFetchHandler();

const assetResponse = await fetchHandler(new Request(`${baseUrl}/privacy/`), env);
assertEqual(assetResponse.status, 200, 'static assets should be served');
assertEqual(await assetResponse.text(), 'asset:/privacy/', 'asset binding should receive request');

const optionsResponse = await fetchHandler(
  new Request(`${baseUrl}${defaultCloudflarePagesBridgeEndpoint}`, {
    method: 'OPTIONS',
  }),
  env,
);
assertEqual(optionsResponse.status, 204, 'bridge OPTIONS should return 204');
assertEqual(
  optionsResponse.headers.get('access-control-allow-origin'),
  '*',
  'bridge OPTIONS should include CORS headers',
);

const rpcOptionsResponse = await fetchHandler(
  new Request(`${baseUrl}${defaultBridgeRpcEndpoint}`, {
    method: 'OPTIONS',
  }),
  env,
);
assertEqual(rpcOptionsResponse.status, 204, 'oRPC OPTIONS should return 204');

const capabilities = await postBridge({
  id: 'capabilities-1',
  method: 'runtime.getCapabilities',
  payload: {},
  meta: requestMeta(),
});
assertEqual(capabilities.ok, true, 'direct bridge capabilities should succeed');
assertEqual(
  (capabilities as { readonly data: { readonly cloudSave: boolean } }).data.cloudSave,
  false,
  'default capabilities should not expose unauthenticated cloud save',
);
assertEqual(
  (capabilities as { readonly data: { readonly socialShare: boolean } }).data.socialShare,
  false,
  'default capabilities should not advertise unavailable server-side sharing',
);

const client = createBridgeOrpcClient({
  fetch: (url, init) => fetchHandler(new Request(new URL(String(url), baseUrl), init), env),
});
const player = await client.request({
  id: 'player-1',
  method: 'identity.getPlayer',
  payload: {},
  meta: requestMeta(),
});

assertEqual(player.ok ? player.data : undefined, null, 'default oRPC identity should be anonymous');

const missingStorage = await client.request({
  id: 'storage-load-1',
  method: 'storage.load',
  payload: { key: 'missing:v1' },
  meta: requestMeta(),
});
assertDeepEqual(
  missingStorage.ok ? missingStorage.data : undefined,
  { found: false },
  'default Pages storage should use the shared missing-value envelope',
);

const session = await client.request({
  id: 'session-1',
  method: 'identity.getSession',
  payload: {},
  meta: requestMeta(),
});
assertDeepEqual(
  session.ok ? session.data : undefined,
  {
    identityLevel: 'guest',
    trustLevel: 'local',
  },
  'default oRPC identity session should stay local and anonymous',
);

const platformFlowFallbacks = [
  {
    method: 'identity.getSession',
    payload: {},
    expected: { identityLevel: 'guest', trustLevel: 'local' },
  },
  {
    method: 'identity.requestUpgrade',
    payload: { reason: 'save' },
    expected: { status: 'unavailable', reloadExpected: false },
  },
  {
    method: 'presentation.getLaunchIntent',
    payload: {},
    expected: { entry: 'home' },
  },
  {
    method: 'presentation.requestGameSurface',
    payload: { entry: 'home' },
    expected: 'already-fullscreen',
  },
  {
    method: 'share.share',
    payload: {
      kind: 'daily-result',
      title: 'Daily result',
      text: 'Finished the daily puzzle.',
      deepLink: 'https://game.example/daily',
    },
    expected: { status: 'unavailable' },
  },
  {
    method: 'share.readInboundShare',
    payload: {},
    expected: null,
  },
  {
    method: 'notifications.getStatus',
    payload: { topic: 'daily-ready' },
    expected: 'unsupported',
  },
  {
    method: 'notifications.requestSubscription',
    payload: { topic: 'daily-ready' },
    expected: 'unavailable',
  },
] as const satisfies readonly {
  readonly method: BridgeRequest['method'];
  readonly payload: unknown;
  readonly expected: unknown;
}[];

for (const [index, fallback] of platformFlowFallbacks.entries()) {
  const response = await postBridge({
    id: `platform-flow-${String(index)}`,
    method: fallback.method,
    payload: fallback.payload,
    meta: requestMeta(),
  });

  assertDeepEqual(
    response.ok ? response.data : undefined,
    fallback.expected,
    `${fallback.method} should return its conservative Pages fallback`,
  );
}

const gameServicesResponse = await fetchHandler(
  new Request(`${baseUrl}${defaultCloudflarePagesGameServicesPrefix}/rpc`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      cookie: 'session=secret',
    },
    body: 'rpc-body',
  }),
  env,
);
assertEqual(gameServicesResponse.status, 200, 'game-services binding proxy should respond');
assertEqual(
  gameServicesResponse.headers.get('access-control-allow-origin'),
  '*',
  'game-services proxy should include CORS headers',
);
assertEqual(
  gameServicesRequests[0]?.path,
  '/rpc',
  'game-services binding proxy should strip the public prefix',
);
assertEqual(
  gameServicesRequests[0]?.headers.get('authorization'),
  'Bearer test-token',
  'game-services proxy should forward configured auth headers',
);
assertEqual(
  gameServicesRequests[0]?.headers.get('cookie'),
  null,
  'game-services proxy should not forward cookies by default',
);

const gameServicesOptionsResponse = await fetchHandler(
  new Request(`${baseUrl}${defaultCloudflarePagesGameServicesPrefix}/rpc`, {
    method: 'OPTIONS',
  }),
  env,
);
assertEqual(gameServicesOptionsResponse.status, 204, 'game-services OPTIONS should return 204');

const invalidProxyPathResponse = await fetchHandler(
  new Request(`${baseUrl}${defaultCloudflarePagesGameServicesPrefix}/%2525252e%2525252e/health`),
  env,
);
assertEqual(
  invalidProxyPathResponse.status,
  400,
  'game-services proxy should reject repeatedly encoded parent paths',
);

const encodedSlashProxyPathResponse = await fetchHandler(
  new Request(`${baseUrl}${defaultCloudflarePagesGameServicesPrefix}/..%2f..%2fadmin`),
  env,
);
assertEqual(
  encodedSlashProxyPathResponse.status,
  400,
  'game-services proxy should reject parent paths with encoded slashes',
);

const missingBindingResponse = await fetchHandler(
  new Request(`${baseUrl}${defaultCloudflarePagesGameServicesPrefix}/health`),
  {
    ASSETS: createAssetBinding(),
  },
);
assertEqual(missingBindingResponse.status, 503, 'missing game-services binding should return 503');

const throwingFetchHandler = createMpgdCloudflarePagesHostFetchHandler({
  bridgeHandler() {
    throw new Error('boom');
  },
});
const originalConsoleError = console.error;
console.error = () => {};

let throwingResponse: Response | undefined;

try {
  throwingResponse = await throwingFetchHandler(
    new Request(`${baseUrl}${defaultCloudflarePagesBridgeEndpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'throw-1',
        method: 'identity.getPlayer',
        payload: {},
        meta: requestMeta(),
      } satisfies BridgeRequest),
    }),
    env,
  );
} finally {
  console.error = originalConsoleError;
}

if (throwingResponse === undefined) {
  throw new Error('Expected throwing bridge handler response.');
}

const throwingBody = await throwingResponse.json() as BridgeResponse;
assertEqual(throwingResponse.status, 500, 'bridge handler errors should return 500');
assertEqual(throwingBody.ok, false, 'bridge handler errors should use BridgeResponse shape');
assertEqual(
  throwingBody.ok ? undefined : throwingBody.error.message,
  'An internal error occurred while processing the bridge request.',
  'bridge handler errors should use a generic client-safe message',
);

console.log('Cloudflare Pages host bridge smoke passed');

async function postBridge(input: BridgeRequest): Promise<BridgeResponse> {
  const response = await fetchHandler(
    new Request(`${baseUrl}${defaultCloudflarePagesBridgeEndpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    }),
    env,
  );

  return await response.json() as BridgeResponse;
}

function requestMeta(): BridgeRequest['meta'] {
  return {
    target: 'web-preview',
    appVersion: '0.0.0-test',
    buildId: 'pages-host-test',
    sentAt: '2026-07-07T00:00:00.000Z',
  };
}

function createAssetBinding(): CloudflarePagesAssetsBinding {
  return {
    async fetch(request) {
      return new Response(`asset:${new URL(request.url).pathname}`);
    },
  };
}

function createGameServicesBinding(
  requests: { readonly path: string; readonly headers: Headers }[],
): CloudflarePagesServiceBinding {
  return {
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        headers: new Headers(request.headers),
      });
      return new Response('game-services');
    },
  };
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, received ${actualJson}.`);
  }
}
