import {
  createMicrosoftStoreIdentityCredentialsResponse,
  microsoftStoreIdentityCredentialsSchema,
  parseMicrosoftStoreIdentityCredentialsRequest,
  parseMicrosoftStoreIdentityCredentialsResponse,
  resolveMicrosoftStoreIdentityCredentials,
} from './microsoft-store-identity';

const request = parseMicrosoftStoreIdentityCredentialsRequest({
  schema: microsoftStoreIdentityCredentialsSchema,
  gameId: 'ttokdoku',
  playerId: 'microsoft.0123456789abcdef',
});

assertDeepEqual(request, {
  schema: microsoftStoreIdentityCredentialsSchema,
  gameId: 'ttokdoku',
  playerId: 'microsoft.0123456789abcdef',
});

assertDeepEqual(createMicrosoftStoreIdentityCredentialsResponse({
  request,
  credentials: {
    accessToken: 'service-token',
    userStoreId: 'user-store-id',
    accountBindingId: 'account-binding-id',
    sandbox: 'RETAIL',
  },
}), {
  schema: microsoftStoreIdentityCredentialsSchema,
  gameId: 'ttokdoku',
  playerId: 'microsoft.0123456789abcdef',
  accessToken: 'service-token',
  userStoreId: 'user-store-id',
  accountBindingId: 'account-binding-id',
  sandbox: 'RETAIL',
});

assertThrows(
  () => parseMicrosoftStoreIdentityCredentialsRequest({
    schema: microsoftStoreIdentityCredentialsSchema,
    gameId: 'ttokdoku',
    playerId: 'player',
    authority: 'client-controlled',
  }),
  /shape is invalid/u,
);

assertThrows(
  () => parseMicrosoftStoreIdentityCredentialsResponse(
    {
      schema: microsoftStoreIdentityCredentialsSchema,
      gameId: 'revolving-cards',
      playerId: request.playerId,
      accessToken: 'service-token',
      userStoreId: 'user-store-id',
      accountBindingId: 'account-binding-id',
    },
    request,
  ),
  /scope does not match/u,
);

assertThrows(
  () => parseMicrosoftStoreIdentityCredentialsResponse({
    schema: microsoftStoreIdentityCredentialsSchema,
    gameId: request.gameId,
    playerId: request.playerId,
    accessToken: 'x'.repeat(4_097),
    userStoreId: 'user-store-id',
    accountBindingId: 'account-binding-id',
  }),
  /access token is invalid/u,
);

let capturedRequest: unknown;
const credentials = await resolveMicrosoftStoreIdentityCredentials({
  authority: {
    async fetch(_input, init) {
      capturedRequest = JSON.parse(String(init?.body)) as unknown;
      return Response.json({
        schema: microsoftStoreIdentityCredentialsSchema,
        gameId: 'ttokdoku',
        playerId: 'microsoft.0123456789abcdef',
        accessToken: 'service-token',
        userStoreId: 'user-store-id',
        accountBindingId: 'account-binding-id',
      });
    },
  },
  gameId: 'ttokdoku',
  playerId: 'microsoft.0123456789abcdef',
});
assertDeepEqual(capturedRequest, request);
assertDeepEqual(credentials, {
  schema: microsoftStoreIdentityCredentialsSchema,
  gameId: 'ttokdoku',
  playerId: 'microsoft.0123456789abcdef',
  accessToken: 'service-token',
  userStoreId: 'user-store-id',
  accountBindingId: 'account-binding-id',
});

await assertRejects(
  resolveMicrosoftStoreIdentityCredentials({
    authority: { fetch: () => Promise.resolve(Response.json({}, { status: 404 })) },
    gameId: 'ttokdoku',
    playerId: 'microsoft.0123456789abcdef',
  }),
  'MICROSOFT_STORE_ACCOUNT_LINK_REQUIRED',
);

const errorResponseAbort = new AbortController();
const errorResponseAbortReason = new Error('caller stopped error response cleanup');
await assertRejectsSame(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.resolve(new Response(new ReadableStream({
        cancel() {
          errorResponseAbort.abort(errorResponseAbortReason);
        },
      }), { status: 404 })),
    },
    gameId: request.gameId,
    playerId: request.playerId,
    signal: errorResponseAbort.signal,
  }),
  errorResponseAbortReason,
);

await assertRejects(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.resolve(Response.json({
        schema: microsoftStoreIdentityCredentialsSchema,
        gameId: 'revolving-cards',
        playerId: 'microsoft.0123456789abcdef',
        accessToken: 'service-token',
        userStoreId: 'user-store-id',
        accountBindingId: 'account-binding-id',
      })),
    },
    gameId: 'ttokdoku',
    playerId: 'microsoft.0123456789abcdef',
  }),
  'MICROSOFT_STORE_IDENTITY_RESPONSE_INVALID',
);

const invalidBodyCleanupAbort = new AbortController();
const invalidBodyCleanupAbortReason = new Error('caller stopped invalid-body cleanup');
await assertRejectsSame(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.resolve(new Response(new ReadableStream({
        cancel() {
          invalidBodyCleanupAbort.abort(invalidBodyCleanupAbortReason);
        },
      }), { headers: { 'Content-Length': 'not-a-number' } })),
    },
    gameId: request.gameId,
    playerId: request.playerId,
    signal: invalidBodyCleanupAbort.signal,
  }),
  invalidBodyCleanupAbortReason,
);

const callerAbortReason = new Error('caller stopped Store checkout');
const callerAbort = new AbortController();
callerAbort.abort(callerAbortReason);
await assertRejectsSame(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch(_input, init) {
        return Promise.reject(init?.signal?.reason);
      },
    },
    gameId: 'ttokdoku',
    playerId: 'microsoft.0123456789abcdef',
    signal: callerAbort.signal,
  }),
  callerAbortReason,
);

await assertRejectsSame(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.reject(new DOMException('wrapped abort', 'AbortError')),
    },
    gameId: 'ttokdoku',
    playerId: 'microsoft.0123456789abcdef',
    signal: callerAbort.signal,
  }),
  callerAbortReason,
);

await assertRejects(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.reject(new Error('transport failed while already aborted')),
    },
    gameId: 'ttokdoku',
    playerId: 'microsoft.0123456789abcdef',
    signal: callerAbort.signal,
  }),
  'MICROSOFT_STORE_IDENTITY_UNAVAILABLE',
);

const timeoutError = await captureRejection(resolveMicrosoftStoreIdentityCredentials({
  authority: {
    fetch(_input, init) {
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(init.signal?.reason),
            { once: true },
          );
        },
      })));
    },
  },
  gameId: 'ttokdoku',
  playerId: 'microsoft.0123456789abcdef',
  timeoutMs: 1,
}));
assertMatch(timeoutError, /timed out/u);

const wrappedBodyAbort = new AbortController();
const wrappedBodyAbortReason = new Error('caller stopped response streaming');
await assertRejectsSame(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.resolve(new Response(new ReadableStream({
        pull(controller) {
          wrappedBodyAbort.abort(wrappedBodyAbortReason);
          controller.error(new DOMException('wrapped body abort', 'AbortError'));
        },
      }))),
    },
    gameId: 'ttokdoku',
    playerId: 'microsoft.0123456789abcdef',
    signal: wrappedBodyAbort.signal,
  }),
  wrappedBodyAbortReason,
);

const oversizedBodyCleanupAbort = new AbortController();
const oversizedBodyCleanupAbortReason = new Error('caller stopped oversized-body cleanup');
await assertRejectsSame(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.resolve(new Response(new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(16 * 1_024 + 1));
        },
        cancel() {
          oversizedBodyCleanupAbort.abort(oversizedBodyCleanupAbortReason);
        },
      }))),
    },
    gameId: request.gameId,
    playerId: request.playerId,
    signal: oversizedBodyCleanupAbort.signal,
  }),
  oversizedBodyCleanupAbortReason,
);

await assertRejects(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.resolve(new Response('{}', {
        headers: { 'Content-Length': 'not-a-number' },
      })),
    },
    gameId: 'ttokdoku',
    playerId: 'microsoft.0123456789abcdef',
  }),
  'MICROSOFT_STORE_IDENTITY_RESPONSE_INVALID',
);

for (const contentLength of [
  '1e3',
  '0x10',
  ' 42 ',
  '',
  '99999',
  '999999999999999999999999999999',
]) {
  await assertRejects(
    resolveMicrosoftStoreIdentityCredentials({
      authority: {
        fetch: () => Promise.resolve(new Response('{}', {
          headers: { 'Content-Length': contentLength },
        })),
      },
      gameId: 'ttokdoku',
      playerId: 'microsoft.0123456789abcdef',
    }),
    'MICROSOFT_STORE_IDENTITY_RESPONSE_INVALID',
  );
}

const malformedUtf8Prefix = new TextEncoder().encode(
  `{"schema":"${microsoftStoreIdentityCredentialsSchema}",`
    + `"gameId":"${request.gameId}","playerId":"${request.playerId}",`
    + '"accessToken":"',
);
const malformedUtf8Suffix = new TextEncoder().encode(
  '","userStoreId":"user-store-id","accountBindingId":"account-binding-id"}',
);
await assertRejects(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.resolve(new Response(new Uint8Array([
        ...malformedUtf8Prefix,
        0xc3,
        0x28,
        ...malformedUtf8Suffix,
      ]))),
    },
    gameId: request.gameId,
    playerId: request.playerId,
  }),
  'MICROSOFT_STORE_IDENTITY_RESPONSE_INVALID',
);

await assertRejects(
  resolveMicrosoftStoreIdentityCredentials({
    authority: {
      fetch: () => Promise.resolve(Response.json({
        schema: microsoftStoreIdentityCredentialsSchema,
        gameId: request.gameId,
        playerId: request.playerId,
        accessToken: 'service-token',
        userStoreId: 'user-store-id',
        accountBindingId: '\ud800',
      })),
    },
    gameId: request.gameId,
    playerId: request.playerId,
  }),
  'MICROSOFT_STORE_IDENTITY_RESPONSE_INVALID',
);

const forbidden = await captureRejection(
  resolveMicrosoftStoreIdentityCredentials({
    authority: { fetch: () => Promise.resolve(new Response(null, { status: 403 })) },
    gameId: 'ttokdoku',
    playerId: 'microsoft.0123456789abcdef',
  }),
);
assertMatch(forbidden.cause, /HTTP 403/u);

console.log('Microsoft Store identity authority tests passed.');

function assertDeepEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}

function assertThrows(callback: () => unknown, pattern: RegExp): void {
  try {
    callback();
  } catch (error) {
    if (error instanceof Error && pattern.test(error.message)) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected callback to throw ${String(pattern)}.`);
}

async function assertRejects(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && error.message === message) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected promise to reject with ${message}.`);
}

async function assertRejectsSame(promise: Promise<unknown>, expected: unknown): Promise<void> {
  const error = await captureRejection(promise);
  if (error !== expected) {
    throw new Error('Expected promise to preserve the original rejection.');
  }
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected promise to reject.');
}

function assertMatch(value: unknown, pattern: RegExp): void {
  if (!(value instanceof Error) || !pattern.test(value.message)) {
    throw new Error(`Expected ${String(value)} to match ${String(pattern)}.`);
  }
}
