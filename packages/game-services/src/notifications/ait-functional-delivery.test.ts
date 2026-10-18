import assert from 'node:assert/strict';

import { referenceNotificationProviders } from '@mpgd/platform/notifications';

import {
  appsInTossPartnerApiBaseUrl,
  defaultAppsInTossPartnerApiTimeoutMs,
  type AppsInTossMutualTlsFetcher,
} from '../apps-in-toss-partner-api';
import {
  createAitFunctionalMessageDeliveryProvider,
  defaultAitFunctionalMessageBaseUrl,
  defaultAitFunctionalMessageTimeoutMs,
  type AitFunctionalMessageDeliveryRequest,
  type CreateAitFunctionalMessageDeliveryProviderOptions,
} from './ait-functional-delivery';

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type Reply = Response | Error | ((init: RequestInit | undefined) => Promise<Response>);

function fakeMtls(replies: Reply[]): {
  readonly mtls: AppsInTossMutualTlsFetcher;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    mtls: {
      async fetch(url, init) {
        calls.push({ url, init });
        const reply = replies.shift();
        if (reply === undefined) {
          throw new Error('Missing fake Apps in Toss reply.');
        }
        if (reply instanceof Error) {
          throw reply;
        }
        return typeof reply === 'function' ? reply(init) : reply;
      },
    },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type ChannelLists = Readonly<Record<string, readonly unknown[]>>;

const emptyChannels: ChannelLists = {
  sentPush: [],
  sentInbox: [],
  sentSms: [],
  sentAlimtalk: [],
  sentFriendtalk: [],
};

function success(input: {
  readonly msgCount: number;
  readonly detail?: ChannelLists;
  readonly fail?: ChannelLists;
}): Response {
  return json({
    resultType: 'SUCCESS',
    success: {
      msgCount: input.msgCount,
      sentPushCount: input.detail?.['sentPush']?.length ?? 0,
      sentInboxCount: input.detail?.['sentInbox']?.length ?? 0,
      sentSmsCount: 0,
      sentAlimtalkCount: 0,
      sentFriendtalkCount: 0,
      detail: { ...emptyChannels, ...input.detail },
      fail: { ...emptyChannels, ...input.fail },
    },
  });
}

function fail(errorCode: unknown, data?: unknown, status = 200): Response {
  return json(
    {
      resultType: 'FAIL',
      error: { errorCode, reason: 'failed', ...(data === undefined ? {} : { data }) },
    },
    status,
  );
}

const request: AitFunctionalMessageDeliveryRequest = {
  recipient: { kind: 'platform-user', id: 'toss-user-1' },
  topic: {
    id: 'energy-full',
    mapping: { templateSetCode: 'my-game-energy-full', agreement: 'required' },
  },
  templateData: { name: '토스', count: 3, urgent: false },
};

function provider(
  replies: Reply[],
  options: Partial<Omit<CreateAitFunctionalMessageDeliveryProviderOptions, 'mtls'>> = {},
) {
  const fake = fakeMtls(replies);
  return {
    ...fake,
    provider: createAitFunctionalMessageDeliveryProvider({
      mtls: fake.mtls,
      recipientKey: 'toss-user',
      baseUrl: 'https://ait-partner.example',
      ...options,
    }),
  };
}

// The defaults are the partner API client's.
assert.equal(defaultAitFunctionalMessageBaseUrl, appsInTossPartnerApiBaseUrl);
assert.equal(defaultAitFunctionalMessageTimeoutMs, defaultAppsInTossPartnerApiTimeoutMs);

// Transport: one POST per recipient, the template set code and context, the recipient header.
{
  const { provider: ait, calls } = provider([
    success({ msgCount: 1, detail: { sentPush: [{ contentId: 'c-1' }] } }),
  ]);
  assert.equal(ait.id, 'apps-in-toss');
  assert.equal(ait.entry, referenceNotificationProviders['apps-in-toss']);
  assert.deepEqual(ait.entry.limits, [{ count: 10, windowSeconds: 60 }]);
  assert.deepEqual(ait.entry.rate, { count: 15_000, windowSeconds: 60 });
  const answer = await ait.send(request);
  assert.equal(answer.status, 'accepted');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    'https://ait-partner.example/api-partner/v1/apps-in-toss/messenger/send-message',
  );
  const init = calls[0]?.init;
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'manual');
  const headers = new Headers(init?.headers);
  assert.equal(headers.get('x-toss-user-key'), 'toss-user-1');
  assert.equal(headers.get('x-anon-key'), null);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(init?.body)), {
    templateSetCode: 'my-game-energy-full',
    context: { name: '토스', count: 3, urgent: false },
  });
  if (answer.status === 'accepted') {
    assert.equal(answer.messageCount, 1);
    assert.equal(answer.providerMessageId, 'c-1');
    assert.deepEqual(answer.channels.push, { sent: [{ contentId: 'c-1' }], failed: [] });
  }
}

// Anonymous recipient keys use x-anon-key; a send without template data sends an empty context.
{
  const { provider: ait, calls } = provider([success({ msgCount: 1 })], {
    recipientKey: 'anonymous',
  });
  await ait.send({ recipient: { kind: 'platform-user', id: 'anon-1' }, topic: request.topic });
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get('x-anon-key'), 'anon-1');
  assert.equal(headers.get('x-toss-user-key'), null);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)).context, {});
}

// SUCCESS with a per-channel fail list: any sent channel accepts; none sent rejects.
{
  const { provider: ait } = provider(
    [
      success({
        msgCount: 1,
        detail: { sentInbox: [{ contentId: 'in-1' }] },
        fail: { sentPush: [{ contentId: 'p-1', reachedFailReason: 'push token expired' }] },
      }),
      success({
        msgCount: 0,
        fail: { sentPush: [{ contentId: 'p-2', reachedFailReason: 'blocked' }] },
      }),
      success({
        msgCount: 0,
        fail: { sentInbox: [{ contentId: 'p-3', reachedFailReason: ' NOT_AGREED ' }] },
      }),
      success({ msgCount: 0 }),
    ],
    { agreementFailReasons: ['NOT_AGREED'] },
  );
  const partial = await ait.send(request);
  assert.equal(partial.status, 'accepted');
  if (partial.status === 'accepted') {
    assert.equal(partial.providerMessageId, 'in-1');
    assert.deepEqual(partial.channels.inbox.sent, [{ contentId: 'in-1' }]);
    assert.deepEqual(partial.channels.push.failed, [
      { contentId: 'p-1', reachedFailReason: 'push token expired' },
    ]);
  }
  const blocked = await ait.send(request);
  assert.equal(blocked.status, 'rejected');
  assert.equal(blocked.status === 'rejected' ? blocked.reason : undefined, 'recipient');
  const notAgreed = await ait.send(request);
  assert.equal(notAgreed.status === 'rejected' ? notAgreed.reason : undefined, 'agreement');
  const nothing = await ait.send(request);
  assert.equal(nothing.status === 'rejected' ? nothing.reason : undefined, 'recipient');
}

// FAIL business errors.
{
  const { provider: ait } = provider(
    [
      fail('4095', { retryAfterSeconds: 30 }),
      fail('4095', { retryAfterSeconds: '12.5' }),
      fail('4095'),
      fail('4095', { retryAfterSeconds: 1e12 }),
      fail('5004'),
      fail('4034'),
      fail('4010'),
      fail('9001'),
      fail('7777'),
      fail('8888'),
      fail('INVALID_PARAMETER', undefined, 400),
      fail(4095, { retryAfterSeconds: 0 }),
    ],
    { agreementErrorCodes: ['7777'], recipientErrorCodes: ['8888'] },
  );
  assert.deepEqual(await ait.send(request), {
    status: 'rate-limited',
    providerCode: '4095',
    retryAfterSeconds: 30,
  });
  assert.deepEqual(await ait.send(request), {
    status: 'rate-limited',
    providerCode: '4095',
    retryAfterSeconds: 13,
  });
  assert.deepEqual(await ait.send(request), { status: 'rate-limited', providerCode: '4095' });
  // A delay is capped at a day.
  assert.deepEqual(await ait.send(request), {
    status: 'rate-limited',
    providerCode: '4095',
    retryAfterSeconds: 86_400,
  });
  for (const code of ['5004', '4034', '4010']) {
    assert.deepEqual(await ait.send(request), {
      status: 'rejected',
      reason: 'configuration',
      providerCode: code,
    });
  }
  // An undocumented business code on HTTP 200 is this recipient's failure,
  // not ambiguous: ambiguous replays have no attempt cap (RFC "Delivery
  // providers -> Apps in Toss").
  assert.deepEqual(await ait.send(request), {
    status: 'rejected',
    reason: 'recipient',
    providerCode: '9001',
  });
  assert.deepEqual(await ait.send(request), {
    status: 'rejected',
    reason: 'agreement',
    providerCode: '7777',
  });
  assert.deepEqual(await ait.send(request), {
    status: 'rejected',
    reason: 'recipient',
    providerCode: '8888',
  });
  // A validation failure is the project's request.
  assert.deepEqual(await ait.send(request), {
    status: 'rejected',
    reason: 'configuration',
    providerCode: 'INVALID_PARAMETER',
  });
  // A numeric code is read as its digits; a zero delay is no delay.
  assert.deepEqual(await ait.send(request), { status: 'rate-limited', providerCode: '4095' });
}

// An undocumented code outside HTTP 200 and the refusing statuses proves nothing.
{
  const { provider: ait } = provider([
    fail('9001', undefined, 409),
    fail('9001', undefined, 202),
    fail('9001', undefined, 404),
    fail('4095', { retryAfterSeconds: 0 }, 200),
  ]);
  assert.deepEqual(await ait.send(request), { status: 'ambiguous', providerCode: '9001' });
  assert.deepEqual(await ait.send(request), { status: 'ambiguous', providerCode: '9001' });
  assert.deepEqual(await ait.send(request), {
    status: 'rejected',
    reason: 'configuration',
    providerCode: '9001',
  });
  assert.deepEqual(await ait.send(request), { status: 'rate-limited', providerCode: '4095' });
}

// The Retry-After header stands in for a missing or unusable body delay.
{
  const { provider: ait } = provider([
    json(
      {
        resultType: 'FAIL',
        error: { errorCode: '4095', reason: 'x', data: { retryAfterSeconds: 0 } },
      },
      429,
      { 'retry-after': '9' },
    ),
    json({ resultType: 'FAIL', error: { errorCode: '4095', reason: 'x' } }, 200, {
      'retry-after': '11',
    }),
  ]);
  assert.deepEqual(await ait.send(request), {
    status: 'rate-limited',
    providerCode: '4095',
    retryAfterSeconds: 9,
  });
  assert.deepEqual(await ait.send(request), {
    status: 'rate-limited',
    providerCode: '4095',
    retryAfterSeconds: 11,
  });
}

// The deployment's codes come before the documented ones, 4095 included.
{
  const { provider: asAgreement } = provider(
    [fail('4095', { retryAfterSeconds: 30 }), fail('5004')],
    { agreementErrorCodes: ['4095', '5004'] },
  );
  assert.deepEqual(await asAgreement.send(request), {
    status: 'rejected',
    reason: 'agreement',
    providerCode: '4095',
  });
  assert.deepEqual(await asAgreement.send(request), {
    status: 'rejected',
    reason: 'agreement',
    providerCode: '5004',
  });
  const { provider: asRecipient } = provider([fail('4095'), fail(4095)], {
    recipientErrorCodes: ['4095'],
  });
  assert.deepEqual(await asRecipient.send(request), {
    status: 'rejected',
    reason: 'recipient',
    providerCode: '4095',
  });
  // A numeric code is read as the same digits.
  assert.deepEqual(await asRecipient.send(request), {
    status: 'rejected',
    reason: 'recipient',
    providerCode: '4095',
  });
}

// HTTP 429 is rate-limited whatever its body; other refusals are configuration.
{
  const { provider: ait } = provider([
    new Response('', { status: 429, headers: { 'retry-after': '7' } }),
    new Response('', { status: 429 }),
    fail('5004', undefined, 429),
    new Response('', { status: 429, headers: { 'retry-after': '999999999' } }),
    new Response('', { status: 401 }),
    new Response('', { status: 403 }),
  ]);
  assert.deepEqual(await ait.send(request), { status: 'rate-limited', retryAfterSeconds: 7 });
  assert.deepEqual(await ait.send(request), { status: 'rate-limited' });
  assert.deepEqual(await ait.send(request), { status: 'rate-limited', providerCode: '5004' });
  assert.deepEqual(await ait.send(request), {
    status: 'rate-limited',
    retryAfterSeconds: 86_400,
  });
  assert.deepEqual(await ait.send(request), { status: 'rejected', reason: 'configuration' });
  assert.deepEqual(await ait.send(request), { status: 'rejected', reason: 'configuration' });
}

// Answers that cannot tell whether the message went out are ambiguous.
{
  const ambiguousTypes = [
    'HTTP_TIMEOUT',
    'NETWORK_ERROR',
    'INTERRUPTED',
    'INTERNAL_ERROR',
    'EXECUTION_FAIL',
  ];
  const unreadable: Reply[] = [
    new Response('upstream down', { status: 503 }),
    new Response('', { status: 408 }),
    new Response('', { status: 425 }),
    new Response('not json', { status: 200 }),
    json({ resultType: 'SUCCESS', success: { msgCount: 'one' } }),
    json({ resultType: 'SUCCESS' }),
    json({ resultType: 'SUCCESS', success: { msgCount: 1 } }, 409),
    new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
    new Response('x'.repeat(256 * 1024 + 1), { status: 200 }),
    new Response('{}', { status: 200, headers: { 'content-length': String(1024 * 1024) } }),
  ];
  const { provider: ait } = provider([
    ...ambiguousTypes.map((resultType) =>
      json({ resultType, error: { errorCode: 'X', reason: 'x' } })),
    fail('5004', undefined, 500),
    json({ resultType: 'FAIL', error: { reason: 'no code' } }),
    fail({ nested: true }),
    new TypeError('network failed'),
    ...unreadable,
  ]);
  for (const resultType of ambiguousTypes) {
    assert.deepEqual(await ait.send(request), { status: 'ambiguous', providerCode: resultType });
  }
  assert.deepEqual(await ait.send(request), { status: 'ambiguous', providerCode: '5004' });
  assert.deepEqual(await ait.send(request), { status: 'ambiguous', providerCode: 'FAIL' });
  assert.deepEqual(await ait.send(request), { status: 'ambiguous', providerCode: 'FAIL' });
  assert.deepEqual(await ait.send(request), {
    status: 'ambiguous',
    providerCode: 'TRANSPORT_ERROR',
  });
  for (let index = 0; index < unreadable.length; index += 1) {
    assert.equal(
      (await ait.send(request)).status,
      'ambiguous',
      `reply ${index} should be ambiguous`,
    );
  }
}

// A body that fails while it is read is ambiguous.
{
  const broken = new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(new Error('connection reset'));
      },
    }),
    { status: 200 },
  );
  const { provider: ait } = provider([broken]);
  assert.deepEqual(await ait.send(request), {
    status: 'ambiguous',
    providerCode: 'TRANSPORT_ERROR',
  });
}

// A timeout or an aborted caller is ambiguous, and the fetch sees the abort.
{
  let observedAbort = false;
  const hang: Reply = (init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        observedAbort = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
  const { provider: ait } = provider([hang], { timeoutMs: 5 });
  assert.deepEqual(await ait.send(request), { status: 'ambiguous', providerCode: 'TIMEOUT' });
  assert.equal(observedAbort, true);

  const controller = new AbortController();
  controller.abort();
  const { provider: aborted, calls } = provider([hang]);
  assert.deepEqual(await aborted.send({ ...request, signal: controller.signal }), {
    status: 'ambiguous',
    providerCode: 'ABORTED',
  });
  assert.equal(calls.length, 0);

  // A caller that aborts mid-call reaches the fetch through the combined signal.
  observedAbort = false;
  const midway = new AbortController();
  const { provider: abortable } = provider([hang]);
  const pending = abortable.send({ ...request, signal: midway.signal });
  midway.abort();
  assert.deepEqual(await pending, { status: 'ambiguous', providerCode: 'ABORTED' });
  assert.equal(observedAbort, true);
}

// Requests the API would refuse are rejected without a call.
{
  const { provider: ait, calls } = provider([]);
  assert.deepEqual(
    await ait.send({ ...request, topic: { id: 'energy-full', mapping: { agreement: 'required' } } }),
    { status: 'rejected', reason: 'configuration' },
  );
  assert.deepEqual(await ait.send({ ...request, topic: { id: 'energy-full' } }), {
    status: 'rejected',
    reason: 'configuration',
  });
  assert.deepEqual(
    await ait.send({
      ...request,
      templateData: Object.fromEntries(
        Array.from({ length: 129 }, (_value, index) => [`k${index}`, index]),
      ),
    }),
    { status: 'rejected', reason: 'configuration' },
  );
  assert.deepEqual(await ait.send({ ...request, templateData: { n: Number.NaN } }), {
    status: 'rejected',
    reason: 'configuration',
  });
  assert.deepEqual(
    await ait.send({
      ...request,
      recipient: { kind: 'device', installationId: 'i-1', address: { kind: 'fcm-token' } },
    }),
    { status: 'rejected', reason: 'configuration' },
  );
  for (const id of ['', ' padded', 'a\u0000b', '토스', 'x'.repeat(2049)]) {
    assert.deepEqual(await ait.send({ ...request, recipient: { kind: 'platform-user', id } }), {
      status: 'rejected',
      reason: 'recipient',
    });
  }
  assert.equal(calls.length, 0);
}

// Options.
{
  const { mtls } = fakeMtls([]);
  for (const timeoutMs of [0, 0.5, -1, Number.NaN, 60_001]) {
    assert.throws(
      () =>
        createAitFunctionalMessageDeliveryProvider({ mtls, recipientKey: 'toss-user', timeoutMs }),
      /between 1 and 60000/u,
    );
  }
  for (const baseUrl of [
    'http://ait.example',
    'https://user:pass@ait.example',
    'https://ait.example/?x=1',
  ]) {
    assert.throws(
      () =>
        createAitFunctionalMessageDeliveryProvider({ mtls, recipientKey: 'toss-user', baseUrl }),
      /credential-free HTTPS/u,
    );
  }
  assert.throws(
    () => createAitFunctionalMessageDeliveryProvider({ mtls, recipientKey: 'email' as never }),
    /recipientKey/u,
  );
  const { mtls: defaults, calls } = fakeMtls([success({ msgCount: 1 })]);
  await createAitFunctionalMessageDeliveryProvider({ mtls: defaults, recipientKey: 'toss-user' })
    .send(request);
  assert.equal(
    calls[0]?.url,
    'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/messenger/send-message',
  );
  const { mtls: prefixed, calls: prefixedCalls } = fakeMtls([success({ msgCount: 1 })]);
  await createAitFunctionalMessageDeliveryProvider({
    mtls: prefixed,
    recipientKey: 'toss-user',
    baseUrl: 'https://proxy.example/ait',
  }).send(request);
  assert.equal(
    prefixedCalls[0]?.url,
    'https://proxy.example/ait/api-partner/v1/apps-in-toss/messenger/send-message',
  );
}

console.log('Apps in Toss functional message delivery provider tests passed.');
