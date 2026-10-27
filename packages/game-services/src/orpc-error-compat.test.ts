import { createORPCClient, MalformedResponseError, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';

import {
  createGameServicesOrpcClient,
  withLegacyOrpcErrorCompat,
  type GameServicesBackendApi,
} from './client.js';
import type { GameServicesContractClient } from './contract.js';
import { addLegacyOrpcErrorFlag, stripLegacyOrpcErrorFlag } from './orpc-error-compat.js';
import {
  createGameServicesRouter,
  createGameServicesRpcFetchHandler,
  GameServicesRequestValidationError,
} from './server.js';

// The oRPC error-body skew across 2.0.0-beta.34 (middleapi/orpc#1987), checked for every
// pairing of an oRPC 2.0.0-beta.14 peer ("old") and the current one ("new"). The old side is
// not run here: its error bodies are copied from a probe of the 0.30.5 handlers on oRPC
// 2.0.0-beta.14, and its client is represented by a copy of that release's acceptance rule
// (`isORPCErrorJson` in @orpc/client 2.0.0-beta.14). Only the new side runs real code.

const recordedBeta14Errors = {
  badRequest: {
    status: 400,
    body: '{"json":{"defined":false,"inferable":false,"code":"BAD_REQUEST","message":"playerId must be a non-empty string."}}',
  },
  notFound: {
    status: 404,
    body: '{"json":{"defined":false,"inferable":false,"code":"NOT_FOUND","message":"This backend has no ledger status read."}}',
  },
  internal: {
    status: 500,
    body: '{"json":{"defined":false,"inferable":false,"code":"INTERNAL_SERVER_ERROR","message":"Internal Server Error"}}',
  },
} as const;

/** The oRPC 2.0.0-beta.14 client's test for a decodable error body. */
function beta14ClientAccepts(json: unknown): boolean {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return false;
  }
  const record = json as Record<string, unknown>;
  const validKeys = ['defined', 'inferable', 'code', 'message', 'data'];
  if (Object.keys(record).some((key) => !validKeys.includes(key))) {
    return false;
  }
  return typeof record.defined === 'boolean'
    && typeof record.inferable === 'boolean'
    && typeof record.code === 'string'
    && typeof record.message === 'string';
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject.');
}

function errorCode(error: unknown): string {
  return error instanceof ORPCError ? String(error.code) : `not an ORPCError: ${String(error)}`;
}

// old client / old server: the recordings are what a beta.14 client decodes.
for (const [name, recorded] of Object.entries(recordedBeta14Errors)) {
  assertEqual(
    beta14ClientAccepts((JSON.parse(recorded.body) as { readonly json: unknown }).json),
    true,
    `recorded beta.14 ${name} body is decodable by the beta.14 client`,
  );
}

// A backend whose verify fails validation and that has no ledger status or capabilities read.
const backend = {
  version: 'compat-test',
  purchases: {
    async verifyPurchase() {
      throw new GameServicesRequestValidationError('playerId must be a non-empty string.');
    },
  },
  adRewards: {
    async claimAdReward() {
      throw new Error('secret table details');
    },
  },
  leaderboard: {
    async recordScore() {
      return { submitted: true };
    },
  },
} as unknown as GameServicesBackendApi;
const newServer = createGameServicesRpcFetchHandler(
  createGameServicesRouter(backend, { onInternalError: () => {} }),
  { maxBodyBytes: 1024 },
);
const rpcUrl = 'https://game-services.test/rpc';
const post = (path: string, input: unknown, extra: Record<string, unknown> = {}): Request => {
  return new Request(`${rpcUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input, ...extra }),
  });
};

// old client / new server: every error body the server writes stays decodable by beta.14.
const newServerErrors = [
  { path: '/commerce/verifyPurchase', input: {}, status: 400, code: 'BAD_REQUEST' },
  { path: '/commerce/getPurchaseLedgerStatus', input: {}, status: 404, code: 'NOT_FOUND' },
  { path: '/commerce/getCapabilities', input: undefined, status: 404, code: 'NOT_FOUND' },
  { path: '/ads/claimReward', input: {}, status: 500, code: 'INTERNAL_SERVER_ERROR' },
  {
    path: '/ads/claimReward',
    input: { pad: 'x'.repeat(2048) },
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
  },
] as const;
for (const expected of newServerErrors) {
  const response = await newServer(post(expected.path, expected.input));
  assertEqual(response.status, expected.status, `${expected.code} status`);
  const body = await response.json() as { readonly json: Record<string, unknown> };
  assertEqual(body.json.code, expected.code, `${expected.code} code on the wire`);
  assertEqual(body.json.inferable, false, `${expected.code} carries the legacy flag`);
  assertEqual(beta14ClientAccepts(body.json), true, `${expected.code} is decodable by beta.14`);
}

// The server leaves success responses untouched.
const success = await newServer(post('/leaderboard/recordScore', {}));
assertEqual(success.status, 200, 'success status');
assertEqual(await success.text(), '{"json":{"submitted":true}}', 'success body is unchanged');

// new client / old server: the recorded beta.14 errors keep their codes and messages.
let oldServerAnswer: { readonly status: number; readonly body: string } = recordedBeta14Errors.notFound;
const clientOfOldServer = createGameServicesOrpcClient({
  url: rpcUrl,
  fetch: async () => jsonResponse(oldServerAnswer.status, oldServerAnswer.body),
});
oldServerAnswer = recordedBeta14Errors.badRequest;
const oldBadRequest = await captureError(() => {
  return clientOfOldServer.commerce.verifyPurchase({} as never);
});
assertEqual(errorCode(oldBadRequest), 'BAD_REQUEST', 'beta.14 BAD_REQUEST survives');
assertEqual(
  (oldBadRequest as Error).message,
  'playerId must be a non-empty string.',
  'beta.14 validation message survives',
);
oldServerAnswer = recordedBeta14Errors.notFound;
const oldNotFound = await captureError(() => {
  return clientOfOldServer.commerce.getPurchaseLedgerStatus({} as never);
});
assertEqual(errorCode(oldNotFound), 'NOT_FOUND', 'beta.14 NOT_FOUND survives');
oldServerAnswer = recordedBeta14Errors.internal;
assertEqual(
  errorCode(await captureError(() => clientOfOldServer.commerce.getCapabilities())),
  'INTERNAL_SERVER_ERROR',
  'beta.14 INTERNAL_SERVER_ERROR survives',
);

// new client / new server: the codes and messages survive the server's legacy flag.
const clientOfNewServer = createGameServicesOrpcClient({
  url: rpcUrl,
  fetch: (url, init) => newServer(new Request(url, init)),
});
const newBadRequest = await captureError(() => {
  return clientOfNewServer.commerce.verifyPurchase({} as never);
});
assertEqual(errorCode(newBadRequest), 'BAD_REQUEST', 'BAD_REQUEST survives');
assertEqual(
  (newBadRequest as Error).message,
  'playerId must be a non-empty string.',
  'validation message survives',
);
assertEqual(
  errorCode(await captureError(() => clientOfNewServer.commerce.getCapabilities())),
  'NOT_FOUND',
  'NOT_FOUND survives',
);
assertEqual(
  errorCode(
    await captureError(() => clientOfNewServer.ads.claimReward({ pad: 'x'.repeat(2048) } as never)),
  ),
  'PAYLOAD_TOO_LARGE',
  'PAYLOAD_TOO_LARGE survives',
);

// The client strips only a boolean `inferable`: anything else malformed stays malformed.
const malformedBodies = [
  {
    name: 'a non-boolean flag',
    status: 400,
    body: '{"json":{"defined":false,"inferable":"no","code":"BAD_REQUEST","message":"m"}}',
  },
  {
    name: 'an unknown key',
    status: 400,
    body: '{"json":{"defined":false,"inferable":false,"code":"BAD_REQUEST","message":"m","extra":1}}',
  },
  {
    name: 'a missing code',
    status: 400,
    body: '{"json":{"defined":false,"inferable":false,"message":"m"}}',
  },
] as const;
for (const malformed of malformedBodies) {
  const client = createGameServicesOrpcClient({
    url: rpcUrl,
    fetch: async () => jsonResponse(malformed.status, malformed.body),
  });
  const error = await captureError(() => client.commerce.getCapabilities());
  assertEqual(
    error instanceof MalformedResponseError,
    true,
    `${malformed.name} is still rejected as malformed (got ${String(error)})`,
  );
}

// A gateway page and a body labelled JSON that does not parse reach oRPC unchanged, so they
// reject exactly as they would without the shim: never as a decoded ORPCError.
const gatewayPageClient = createGameServicesOrpcClient({
  url: rpcUrl,
  fetch: async () => {
    return new Response('<html>bad gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
  },
});
assertEqual(
  (await captureError(() => gatewayPageClient.commerce.getCapabilities()))
    instanceof MalformedResponseError,
  true,
  'a gateway page is rejected as malformed',
);
const invalidJsonClient = createGameServicesOrpcClient({
  url: rpcUrl,
  fetch: async () => jsonResponse(502, '<html>bad gateway</html>'),
});
assertEqual(
  (await captureError(() => invalidJsonClient.commerce.getCapabilities())) instanceof ORPCError,
  false,
  'a body labelled JSON that does not parse is never decoded as an ORPCError',
);

// A plain oRPC client (not createGameServicesOrpcClient) must wrap its fetch with the exported
// shim while the Worker writes the legacy flag; without it every error is malformed.
const plainLink = (wrap: boolean): GameServicesContractClient => {
  const send = (url: string, init: RequestInit): Promise<Response> => {
    return newServer(new Request(url, init));
  };
  return createORPCClient(
    new RPCLink({ origin: rpcUrl, fetch: wrap ? withLegacyOrpcErrorCompat(send) : send } as never),
  ) as GameServicesContractClient;
};
assertEqual(
  errorCode(await captureError(() => plainLink(true).commerce.getCapabilities())),
  'NOT_FOUND',
  'a plain client with the exported shim keeps NOT_FOUND',
);
assertEqual(
  (await captureError(() => plainLink(false).commerce.getCapabilities()))
    instanceof MalformedResponseError,
  true,
  'a plain client without the shim cannot decode the legacy flag',
);

// A Worker that no longer serves pre-beta.34 clients turns the flag off; plain clients decode.
const flaglessServer = createGameServicesRpcFetchHandler(createGameServicesRouter(backend), {
  legacyOrpcErrorFlag: false,
});
const flaglessAnswer = await flaglessServer(post('/commerce/getCapabilities', undefined));
assertEqual(
  ((await flaglessAnswer.clone().json()) as { readonly json: Record<string, unknown> }).json
    .inferable,
  undefined,
  'legacyOrpcErrorFlag: false writes the current error body',
);
const flaglessClient = createORPCClient(
  new RPCLink({
    origin: rpcUrl,
    fetch: (url: string, init: RequestInit) => flaglessServer(new Request(url, init)),
  } as never),
) as GameServicesContractClient;
assertEqual(
  errorCode(await captureError(() => flaglessClient.commerce.getCapabilities())),
  'NOT_FOUND',
  'a plain client decodes the flagless Worker',
);

// A custom fetch still receives the extra arguments oRPC passes (client options, path).
let forwardedArguments = 0;
const forwardingClient = createGameServicesOrpcClient({
  url: rpcUrl,
  fetch: (async (...args: unknown[]) => {
    forwardedArguments = args.length;
    return newServer(new Request(args[0] as string, args[1] as RequestInit));
  }) as typeof fetch,
});
await captureError(() => forwardingClient.commerce.getCapabilities());
assertEqual(forwardedArguments, 4, 'a custom fetch receives url, init, options, and path');

// Unit edges of the two shims.
const passthrough = jsonResponse(200, '{"json":{"inferable":true}}');
assertEqual(
  await stripLegacyOrpcErrorFlag(passthrough),
  passthrough,
  'client passes successes through',
);
const plainError = new Response('Not Found', {
  status: 404,
  headers: { 'content-type': 'text/plain' },
});
assertEqual(
  await addLegacyOrpcErrorFlag(plainError),
  plainError,
  'server passes non-JSON errors through',
);
const withMeta = await addLegacyOrpcErrorFlag(
  jsonResponse(
    400,
    '{"json":{"defined":true,"code":"C","message":"m","data":{"at":"2026-01-01T00:00:00.000Z"}},"meta":[["date","data","at"]]}',
  ),
);
assertEqual(
  await withMeta.text(),
  '{"json":{"defined":true,"code":"C","message":"m","data":{"at":"2026-01-01T00:00:00.000Z"},"inferable":false},"meta":[["date","data","at"]]}',
  'server keeps data and meta while adding the flag',
);
const stripped = await stripLegacyOrpcErrorFlag(
  new Response('{"json":{"defined":false,"inferable":false,"code":"C","message":"m"}}', {
    status: 400,
    statusText: 'Bad Request',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': '72',
      'x-kept': '1',
    },
  }),
);
assertEqual(stripped.status, 400, 'stripped status');
assertEqual(stripped.statusText, 'Bad Request', 'stripped status text');
assertEqual(stripped.headers.get('x-kept'), '1', 'stripped headers are kept');
assertEqual(stripped.headers.get('content-length'), null, 'stale content-length is dropped');
assertEqual(
  await stripped.text(),
  '{"json":{"defined":false,"code":"C","message":"m"}}',
  'only the flag is removed',
);

console.log('oRPC error-body compatibility (beta.14 <-> beta.46) passed.');

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
