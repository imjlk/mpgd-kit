import type { BridgeRequest, BridgeResponse } from './index';
import {
  createBridgeOrpcClient,
  createBridgeRpcFetchHandler,
  createBridgeRpcRouter,
  defaultBridgeRpcEndpoint,
} from './orpc';

const handler = createBridgeRpcFetchHandler(
  createBridgeRpcRouter((request) => {
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
const client = createBridgeOrpcClient({
  fetch(url, init) {
    fetchUrl = String(url);
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
assertDeepEqual(response, {
  id: request.id,
  ok: true,
  data: {
    playerId: 'orpc-player',
  },
} satisfies BridgeResponse);

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
