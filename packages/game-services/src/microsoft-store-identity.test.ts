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
