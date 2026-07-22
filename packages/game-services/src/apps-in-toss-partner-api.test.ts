import {
  AppsInTossPartnerApiError,
  createAppsInTossPartnerApiClient,
  type AppsInTossMutualTlsFetcher,
} from './apps-in-toss-partner-api';

const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
const responses: Response[] = [];
const mtls = {
  async fetch(url, init) {
    calls.push({ url, init });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error('Missing fake Apps in Toss response.');
    }
    return response;
  },
} satisfies AppsInTossMutualTlsFetcher;
const client = createAppsInTossPartnerApiClient({
  mtls,
  baseUrl: 'https://ait-partner.example',
});

responses.push(jsonResponse({ resultType: 'SUCCESS', success: 'true' }));
assertEqual(
  await client.verifyAnonymousKey({ anonymousKey: ' anon-key-1 ' }),
  true,
  'valid anonymous keys should be accepted',
);
assertEqual(
  calls[0]?.url,
  'https://ait-partner.example/api-partner/v1/apps-in-toss/users/anon-key/verify',
  'anonymous-key verification should use the documented route',
);

const prefixedCalls: string[] = [];
const prefixedClient = createAppsInTossPartnerApiClient({
  mtls: {
    async fetch(url) {
      prefixedCalls.push(url);
      return jsonResponse({ resultType: 'SUCCESS', success: 'true' });
    },
  },
  baseUrl: 'https://ait-partner.example/staging/proxy',
});
await prefixedClient.verifyAnonymousKey({ anonymousKey: 'prefixed-anon-key' });
assertEqual(
  prefixedCalls[0],
  'https://ait-partner.example/staging/proxy/api-partner/v1/apps-in-toss/users/anon-key/verify',
  'custom base URL path prefixes should be preserved',
);
assertEqual(
  new Headers(calls[0]?.init?.headers).get('x-anon-key'),
  'anon-key-1',
  'anonymous-key verification should use the documented mTLS header',
);
assertEqual(
  new Headers(calls[0]?.init?.headers).get('content-type'),
  'application/json',
  'anonymous-key verification should use the documented JSON content type',
);
assertEqual(
  calls[0]?.init?.body,
  '',
  'anonymous-key verification should use the documented empty request body',
);

responses.push(
  jsonResponse(
    {
      resultType: 'FAIL',
      error: { errorCode: 'UNAUTHORIZED', reason: 'unknown anonymous key' },
    },
    401,
  ),
);
assertEqual(
  await client.verifyAnonymousKey({ anonymousKey: 'invalid-key' }),
  false,
  'a 401 anonymous-key result should be treated as invalid identity',
);

responses.push(jsonResponse({
  resultType: 'SUCCESS',
  success: {
    msgCount: 1,
    sentPushCount: 1,
    sentInboxCount: 0,
    sentSmsCount: 0,
    sentAlimtalkCount: 0,
    sentFriendtalkCount: 0,
    detail: {
      sentPush: [{ contentId: 'message-1' }],
      sentInbox: [],
      sentSms: [],
      sentAlimtalk: [],
      sentFriendtalk: [],
    },
  },
}));
const message = await client.sendFunctionalMessage({
  recipient: { type: 'anonymous', key: 'anon-key-1' },
  templateSetCode: 'TTOKDOKU_STREAK_AT_RISK',
  context: { remainingHours: 3, playerName: 'Ari', urgent: true },
});
assertEqual(message.messageCount, 1, 'message result should expose provider counts');
assertDeepEqual(message.contentIds, ['message-1'], 'message result should expose content ids');
const messageCall = calls[2];
assertEqual(
  new Headers(messageCall?.init?.headers).get('x-anon-key'),
  'anon-key-1',
  'anonymous recipients should use x-anon-key',
);
assertDeepEqual(
  JSON.parse(String(messageCall?.init?.body)),
  {
    templateSetCode: 'TTOKDOKU_STREAK_AT_RISK',
    context: { remainingHours: 3, playerName: 'Ari', urgent: true },
  },
  'message requests should contain only the approved template and context',
);

responses.push(jsonResponse({ resultType: 'SUCCESS', success: false }));
await assertRejects(
  () => client.verifyAnonymousKey({ anonymousKey: 'malformed-key' }),
  'invalid anonymous-key verification response',
);

responses.push(new Response('x'.repeat(256 * 1_024 + 1)));
await assertRejects(
  () => client.verifyAnonymousKey({ anonymousKey: 'bounded-key' }),
  'response exceeded the maximum accepted size',
  undefined,
  undefined,
  200,
);

const prototypeContext = JSON.parse('{"__proto__":"safe"}') as Record<string, string>;
responses.push(jsonResponse({
  resultType: 'SUCCESS',
  success: {
    msgCount: 0,
    sentPushCount: 0,
    sentInboxCount: 0,
    sentSmsCount: 0,
    sentAlimtalkCount: 0,
    sentFriendtalkCount: 0,
    detail: {},
  },
}));
await client.sendFunctionalMessage({
  recipient: { type: 'toss-user', key: 'toss-user-key-1' },
  templateSetCode: 'SAFE_CONTEXT',
  context: prototypeContext,
});
const prototypeCall = calls[5];
assertDeepEqual(
  JSON.parse(String(prototypeCall?.init?.body)),
  { templateSetCode: 'SAFE_CONTEXT', context: prototypeContext },
  'message context should preserve own prototype-named keys safely',
);
assertEqual(
  new Headers(prototypeCall?.init?.headers).get('x-toss-user-key'),
  'toss-user-key-1',
  'Toss user recipients should use x-toss-user-key',
);

assertThrows(
  () => createAppsInTossPartnerApiClient({ mtls, baseUrl: 'http://ait-partner.example' }),
  'credential-free HTTPS URL',
);
assertThrows(
  () => createAppsInTossPartnerApiClient({
    mtls,
    baseUrl: 'https://ait-partner.example?environment=staging',
  }),
  'credential-free HTTPS URL',
);
assertThrows(
  () => createAppsInTossPartnerApiClient({
    mtls,
    baseUrl: 'https://ait-partner.example#credentials',
  }),
  'credential-free HTTPS URL',
);
assertThrows(() => createAppsInTossPartnerApiClient({ mtls, timeoutMs: 0 }), 'between 1 and 60000');
assertThrows(
  () => createAppsInTossPartnerApiClient({ mtls, timeoutMs: 60_001 }),
  'between 1 and 60000',
);
createAppsInTossPartnerApiClient({ mtls, timeoutMs: 1 });
createAppsInTossPartnerApiClient({ mtls, timeoutMs: 60_000 });
await assertRejectsError(
  () => client.verifyAnonymousKey({ anonymousKey: 'line\nbreak' }),
  'without control or format characters',
);

const oversizedContext = Object.fromEntries(
  Array.from({ length: 129 }, (_, index) => [`field${String(index)}`, index]),
);
await assertRejectsError(
  () => client.sendFunctionalMessage({
    recipient: { type: 'anonymous', key: 'anon-key-1' },
    templateSetCode: 'TOO_MANY_FIELDS',
    context: oversizedContext,
  }),
  'more than 128 values',
);

const transportCause = new Error('socket closed');
const transportClient = createAppsInTossPartnerApiClient({
  mtls: {
    async fetch() {
      throw transportCause;
    },
  },
});
await assertRejects(
  () => transportClient.verifyAnonymousKey({ anonymousKey: 'transport-key' }),
  'transport failed',
  'TRANSPORT_ERROR',
  transportCause,
);

const timeoutClient = createAppsInTossPartnerApiClient({
  mtls: {
    async fetch(_url, init) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    },
  },
  timeoutMs: 1,
});
await assertRejects(
  () => timeoutClient.verifyAnonymousKey({ anonymousKey: 'timeout-key' }),
  'timed out',
  'TIMEOUT',
);

const abortController = new AbortController();
abortController.abort(new Error('caller cancelled'));
const abortClient = createAppsInTossPartnerApiClient({
  mtls: {
    async fetch(_url, init) {
      if (init?.signal?.aborted === true) {
        throw init.signal.reason;
      }
      throw new Error('expected an aborted request');
    },
  },
});
await assertRejects(
  () => abortClient.verifyAnonymousKey({
    anonymousKey: 'aborted-key',
    signal: abortController.signal,
  }),
  'was aborted',
  'ABORTED',
);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function assertThrows(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected operation to throw: ${message}`);
}

async function assertRejects(
  operation: () => Promise<unknown>,
  message: string,
  code?: string,
  cause?: unknown,
  status?: number,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (
      error instanceof AppsInTossPartnerApiError
      && error.message.includes(message)
      && (code === undefined || error.code === code)
      && (cause === undefined || error.cause === cause)
      && (status === undefined || error.status === status)
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected operation to reject: ${message}`);
}

async function assertRejectsError(
  operation: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(message)) {
      return;
    }
    throw error;
  }
  throw new Error(`Expected operation to reject: ${message}`);
}
