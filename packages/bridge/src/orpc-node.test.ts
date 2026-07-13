import { createServer } from 'node:http';

import type { BridgeRequest, BridgeResponse } from './index';
import {
  createBridgeOrpcClient,
  createBridgeRpcRouter,
  defaultBridgeRpcEndpoint,
  type BridgeRpcEndpoint,
} from './orpc';
import { createBridgeRpcNodeHandler } from './orpc-node';

const nodeHandler = createBridgeRpcNodeHandler(
  createBridgeRpcRouter((request) => ({
    id: request.id,
    ok: true,
    data: {
      transport: 'node-http',
    },
  } satisfies BridgeResponse)),
);
const server = createServer((request, response) => {
  if (request.headers['x-mpgd-force-handler-error'] === 'true') {
    Object.defineProperty(request, 'url', {
      configurable: true,
      get() {
        throw new Error('Forced Node HTTP adapter failure.');
      },
    });
  }

  void nodeHandler(request, response).then((matched) => {
    if (!matched) {
      response.statusCode = 404;
      response.end('Not Found');
    }
  });
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address for the bridge Node HTTP test server.');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = createBridgeOrpcClient({
    url: `${baseUrl}${defaultBridgeRpcEndpoint}` as BridgeRpcEndpoint,
  });
  const request = {
    id: 'node-request-1',
    method: 'identity.getPlayer',
    payload: {},
    meta: {
      target: 'reddit',
      appVersion: '1.0.0',
      buildId: 'test',
      sentAt: '2026-07-14T00:00:00.000Z',
    },
  } satisfies BridgeRequest;
  const response = await client.request(request);

  assertDeepEqual(response, {
    id: request.id,
    ok: true,
    data: {
      transport: 'node-http',
    },
  } satisfies BridgeResponse);

  const notFoundResponse = await fetch(`${baseUrl}/api/mpgd/missing`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  assertEqual(notFoundResponse.status, 404, 'unmatched Node HTTP routes should remain available');

  const originalConsoleError = console.error;
  const capturedErrors: unknown[][] = [];
  let internalErrorResponse: Response;

  console.error = (...args: unknown[]) => {
    capturedErrors.push(args);
  };

  try {
    internalErrorResponse = await fetch(`${baseUrl}${defaultBridgeRpcEndpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mpgd-force-handler-error': 'true',
      },
      body: JSON.stringify(request),
    });
  } finally {
    console.error = originalConsoleError;
  }

  assertEqual(
    internalErrorResponse.status,
    500,
    'unexpected Node HTTP handler failures should complete with status 500',
  );
  assertEqual(capturedErrors.length, 1, 'unexpected Node HTTP handler failures should be logged');
  assertEqual(
    internalErrorResponse.headers.get('cache-control'),
    'no-store',
    'internal error responses should not be cached',
  );
  assertDeepEqual(await internalErrorResponse.json(), {
    error: 'BRIDGE_RPC_INTERNAL_ERROR',
  });
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

console.log('Bridge oRPC Node HTTP smoke test passed.');

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
