import assert from 'node:assert/strict';

import { referenceNotificationProviders } from '@mpgd/platform/notifications';

import type { AppsInTossMutualTlsFetcher } from '../apps-in-toss-partner-api';
import {
  createAitFunctionalMessageDeliveryProvider,
  type AitFunctionalMessageDeliveryRequest,
  type CreateAitFunctionalMessageDeliveryProviderOptions,
} from './ait-functional-delivery';

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type Reply = Response | Error | ((init: RequestInit | undefined) => Promise<Response>);

function fakeMtls(replies: Reply[]): { readonly mtls: AppsInTossMutualTlsFetcher; readonly calls: Call[] } {
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
  recipient: { type: 'toss-user', key: 'toss-user-1' },
  topic: {
    id: 'energy-full',
    mapping: { templateSetCode: 'my-game-energy-full', agreement: 'required' },
  },
  templateData: { name: '토스', count: 3, urgent: false },
};

function provider(
  replies: Reply[],
  options: Omit<CreateAitFunctionalMessageDeliveryProviderOptions, 'mtls'> = {},
) {
  const fake = fakeMtls(replies);
  return {
    ...fake,
    provider: createAitFunctionalMessageDeliveryProvider({
      mtls: fake.mtls,
      baseUrl: 'https://ait-partner.example',
      ...options,
    }),
  };
}

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
    assert.deepEqual(answer.channels.push, { sent: [{ contentId: 'c-1' }], failed: [] });
  }
}

// Anonymous recipients use x-anon-key; a send without template data sends an empty context.
{
  const { provider: ait, calls } = provider([success({ msgCount: 1 })]);
  await ait.send({ recipient: { type: 'anonymous', key: 'anon-1' }, topic: request.topic });
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
        fail: { sentInbox: [{ contentId: 'p-3', reachedFailReason: 'NOT_AGREED' }] },
      }),
      success({ msgCount: 0 }),
    ],
    { agreementFailReasons: ['NOT_AGREED'] },
  );
  const partial = await ait.send(request);
  assert.equal(partial.status, 'accepted');
  if (partial.status === 'accepted') {
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
    hostCode: '4095',
    retryAfterSeconds: 30,
  });
  assert.deepEqual(await ait.send(request), {
    status: 'rate-limited',
    hostCode: '4095',
    retryAfterSeconds: 13,
  });
  assert.deepEqual(await ait.send(request), { status: 'rate-limited', hostCode: '4095' });
  for (const code of ['5004', '4034', '4010']) {
    assert.deepEqual(await ait.send(request), {
      status: 'rejected',
      reason: 'configuration',
      hostCode: code,
    });
  }
  // An undocumented business code on HTTP 200 is this recipient's failure.
  assert.deepEqual(await ait.send(request), {
    status: 'rejected',
    reason: 'recipient',
    hostCode: '9001',
  });
  assert.deepEqual(await ait.send(request), {
    status: 'rejected',
    reason: 'agreement',
    hostCode: '7777',
  });
  assert.deepEqual(await ait.send(request), {
    status: 'rejected',
    reason: 'recipient',
    hostCode: '8888',
  });
  // A validation failure is the project's request.
  assert.deepEqual(await ait.send(request), {
    status: 'rejected',
    reason: 'configuration',
    hostCode: 'INVALID_PARAMETER',
  });
  // A numeric code is read as its digits; a zero delay is no delay.
  assert.deepEqual(await ait.send(request), { status: 'rate-limited', hostCode: '4095' });
}

// Answers that cannot tell whether the message went out are ambiguous.
{
  const replies: Reply[] = [
    ...['HTTP_TIMEOUT', 'NETWORK_ERROR', 'INTERRUPTED', 'INTERNAL_ERROR', 'EXECUTION_FAIL'].map(
      (resultType) => json({ resultType, error: { errorCode: 'X', reason: 'x' } }),
    ),
    fail('5004', undefined, 500),
    new Response('upstream down', { status: 503 }),
    new TypeError('network failed'),
    new Response('not json', { status: 200 }),
    json({ resultType: 'SUCCESS', success: { msgCount: 'one' } }),
    json({ resultType: 'SUCCESS' }),
    new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
    new Response('x'.repeat(256 * 1024 + 1), { status: 200 }),
  ];
  const { provider: ait } = provider(replies);
  for (const resultType of [
    'HTTP_TIMEOUT',
    'NETWORK_ERROR',
    'INTERRUPTED',
    'INTERNAL_ERROR',
    'EXECUTION_FAIL',
  ]) {
    assert.deepEqual(await ait.send(request), { status: 'ambiguous', hostCode: resultType });
  }
  assert.deepEqual(await ait.send(request), { status: 'ambiguous', hostCode: '5004' });
  for (let index = 0; index < 7; index += 1) {
    assert.equal(
      (await ait.send(request)).status,
      'ambiguous',
      `reply ${index} should be ambiguous`,
    );
  }
}

// HTTP 429 and other HTTP errors without a business envelope.
{
  const { provider: ait } = provider([
    new Response('', { status: 429, headers: { 'retry-after': '7' } }),
    new Response('', { status: 429 }),
    new Response('', { status: 401 }),
    new Response('', { status: 403 }),
  ]);
  assert.deepEqual(await ait.send(request), { status: 'rate-limited', retryAfterSeconds: 7 });
  assert.deepEqual(await ait.send(request), { status: 'rate-limited' });
  assert.deepEqual(await ait.send(request), { status: 'rejected', reason: 'configuration' });
  assert.deepEqual(await ait.send(request), { status: 'rejected', reason: 'configuration' });
}

// A timeout or an aborted caller is ambiguous, and the fetch sees the abort.
{
  let observedAbort = false;
  const hang: Reply = (init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      observedAbort = true;
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
  const { provider: ait } = provider([hang], { timeoutMs: 5 });
  assert.deepEqual(await ait.send(request), { status: 'ambiguous' });
  assert.equal(observedAbort, true);

  const controller = new AbortController();
  controller.abort();
  const { provider: aborted, calls } = provider([hang]);
  assert.deepEqual(await aborted.send({ ...request, signal: controller.signal }), {
    status: 'ambiguous',
  });
  assert.equal(calls.length, 0);

  // A caller that aborts mid-call reaches the fetch through the combined signal.
  observedAbort = false;
  const midway = new AbortController();
  const { provider: abortable } = provider([hang]);
  const pending = abortable.send({ ...request, signal: midway.signal });
  midway.abort();
  assert.deepEqual(await pending, { status: 'ambiguous' });
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
    await ait.send({ ...request, templateData: Object.fromEntries(
      Array.from({ length: 129 }, (_value, index) => [`k${index}`, index]),
    ) }),
    { status: 'rejected', reason: 'configuration' },
  );
  assert.deepEqual(await ait.send({ ...request, templateData: { n: Number.NaN } }), {
    status: 'rejected',
    reason: 'configuration',
  });
  for (const key of ['', ' padded ', 'a\u0000b', 'x'.repeat(2049)]) {
    assert.deepEqual(await ait.send({ ...request, recipient: { type: 'toss-user', key } }), {
      status: 'rejected',
      reason: 'recipient',
    });
  }
  assert.deepEqual(
    await ait.send({ ...request, recipient: { type: 'email', key: 'a' } as never }),
    { status: 'rejected', reason: 'recipient' },
  );
  assert.equal(calls.length, 0);
}

// Options.
{
  assert.throws(
    () => createAitFunctionalMessageDeliveryProvider({ mtls: fakeMtls([]).mtls, timeoutMs: 0 }),
    /positive/u,
  );
  const { mtls, calls } = fakeMtls([success({ msgCount: 1 })]);
  await createAitFunctionalMessageDeliveryProvider({ mtls }).send(request);
  assert.equal(
    calls[0]?.url,
    'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/messenger/send-message',
  );
}

console.log('Apps in Toss functional message delivery provider tests passed.');
