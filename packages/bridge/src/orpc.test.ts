import type { BridgeRequest, BridgeResponse } from './index';
import {
  createBridgeOrpcClient,
  createBridgeRpcFetchHandler,
  createBridgeRpcRouter,
  defaultBridgeRpcEndpoint,
} from './orpc';

const handledRequestIds: string[] = [];
const handler = createBridgeRpcFetchHandler(
  createBridgeRpcRouter((request) => {
    handledRequestIds.push(request.id);

    if (request.method !== 'identity.getPlayer') {
      return {
        id: request.id,
        ok: false,
        error: {
          code: 'UNSUPPORTED_METHOD',
          message: 'Unsupported test method.',
          retryable: false,
        },
      } satisfies BridgeResponse;
    }

    return {
      id: request.id,
      ok: true,
      data: {
        playerId: 'orpc-player',
      },
    } satisfies BridgeResponse;
  }),
);

let fetchUrl = '';
let fetchTestHeader = '';
const client = createBridgeOrpcClient({
  headers: {
    'x-mpgd-bridge-test': 'orpc-contract',
  },
  fetch(url, init) {
    fetchUrl = String(url);
    fetchTestHeader = new Headers(init?.headers).get('x-mpgd-bridge-test') ?? '';

    return handler(new Request(`https://bridge.test${url}`, init));
  },
});

const request = {
  id: 'request-1',
  method: 'identity.getPlayer',
  payload: {},
  meta: {
    target: 'reddit',
    appVersion: '1.0.0',
    buildId: 'test',
    sentAt: '2026-07-05T00:00:00.000Z',
  },
} satisfies BridgeRequest;
const response = await client.request(request);

assertEqual(
  fetchUrl.startsWith(defaultBridgeRpcEndpoint),
  true,
  'oRPC client should use bridge endpoint',
);
assertEqual(fetchTestHeader, 'orpc-contract', 'oRPC client should send configured headers');
assertDeepEqual(response, {
  id: request.id,
  ok: true,
  data: {
    playerId: 'orpc-player',
  },
} satisfies BridgeResponse);

const invalidMethodResponse = await client.request({
  ...request,
  id: 'request-invalid-method',
  method: 'identity.invalid',
} as unknown as BridgeRequest);

assertDeepEqual(invalidMethodResponse, {
  id: 'request-invalid-method',
  ok: false,
  error: {
    code: 'INVALID_BRIDGE_REQUEST',
    message: invalidMethodResponse.ok ? '' : invalidMethodResponse.error.message,
    retryable: false,
  },
} satisfies BridgeResponse);

const missingIdResponse = await client.request({
  ...request,
  id: undefined,
} as unknown as BridgeRequest);

assertDeepEqual(missingIdResponse, {
  id: 'unknown',
  ok: false,
  error: {
    code: 'INVALID_BRIDGE_REQUEST',
    message: missingIdResponse.ok ? '' : missingIdResponse.error.message,
    retryable: false,
  },
} satisfies BridgeResponse);
assertEqual(
  handledRequestIds.join(','),
  'request-1',
  'invalid bridge requests should fail validation before reaching the handler',
);

const notFoundResponse = await handler(
  new Request('https://bridge.test/api/mpgd/missing/request', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  }),
);

assertEqual(notFoundResponse.status, 404, 'unmatched oRPC routes should return 404');
assertEqual(
  await notFoundResponse.text(),
  'Not Found',
  'unmatched oRPC routes should return text body',
);

const internalErrorHandler = createBridgeRpcFetchHandler(
  createBridgeRpcRouter(() => {
    throw new Error('boom');
  }),
);
let internalErrorResponse: Response | undefined;
const internalErrorClient = createBridgeOrpcClient({
  async fetch(url, init) {
    const fetchResponse = await internalErrorHandler(
      new Request(`https://bridge.test${url}`, init),
    );
    internalErrorResponse = fetchResponse.clone();

    return fetchResponse;
  },
});
let internalErrorThrown = false;

try {
  await internalErrorClient.request(request);
} catch {
  internalErrorThrown = true;
}

assertEqual(internalErrorThrown, true, 'internal oRPC handler errors should reject the client');
assertEqual(internalErrorResponse?.status, 500, 'internal oRPC handler errors should return 500');
assertDeepEqual(await internalErrorResponse?.json(), {
  json: {
    defined: false,
    inferable: false,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal Server Error',
  },
});

console.log('Bridge oRPC contract smoke test passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);

  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, received ${actualJson}.`);
  }
}
