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
      allowUnlistedHost: true,
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

// The longest agreement reason the provider can read still matches, padding trimmed.
{
  const longest = 'x'.repeat(1_024);
  const { provider: ait } = provider(
    [
      success({
        msgCount: 0,
        fail: { sentPush: [{ contentId: 'p-4', reachedFailReason: `${longest}${'y'.repeat(10)}` }] },
      }),
    ],
    { agreementFailReasons: [`  ${longest} `] },
  );
  const answer = await ait.send(request);
  assert.equal(answer.status === 'rejected' ? answer.reason : undefined, 'agreement');
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

// Documented codes win over a deployment list, 4095 and 5004 included.
{
  const { provider: asAgreement } = provider(
    [fail('4095', { retryAfterSeconds: 30 }), fail('5004'), fail('7777')],
    { agreementErrorCodes: ['4095', '5004', '7777'] },
  );
  assert.deepEqual(await asAgreement.send(request), {
    status: 'rate-limited',
    providerCode: '4095',
    retryAfterSeconds: 30,
  });
  assert.deepEqual(await asAgreement.send(request), {
    status: 'rejected',
    reason: 'configuration',
    providerCode: '5004',
  });
  assert.deepEqual(await asAgreement.send(request), {
    status: 'rejected',
    reason: 'agreement',
    providerCode: '7777',
  });
  const { provider: asRecipient } = provider(
    [fail('4095'), fail(4095), fail('5004'), fail('8888')],
    { recipientErrorCodes: ['4095', '5004', '8888'] },
  );
  assert.deepEqual(await asRecipient.send(request), {
    status: 'rate-limited',
    providerCode: '4095',
  });
  // A numeric code is read as the same digits, and still cannot override 4095.
  assert.deepEqual(await asRecipient.send(request), {
    status: 'rate-limited',
    providerCode: '4095',
  });
  assert.deepEqual(await asRecipient.send(request), {
    status: 'rejected',
    reason: 'configuration',
    providerCode: '5004',
  });
  assert.deepEqual(await asRecipient.send(request), {
    status: 'rejected',
    reason: 'recipient',
    providerCode: '8888',
  });
  // A code in both sets is an agreement rejection; HTTP 429 stays rate-limited.
  const { provider: both } = provider([fail('7777'), fail('4095', undefined, 429)], {
    agreementErrorCodes: ['7777', '4095'],
    recipientErrorCodes: ['7777'],
  });
  assert.deepEqual(await both.send(request), {
    status: 'rejected',
    reason: 'agreement',
    providerCode: '7777',
  });
  assert.deepEqual(await both.send(request), { status: 'rate-limited', providerCode: '4095' });
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
  // An agreement reason the provider could never match is refused at creation.
  for (const reason of ['', '   ', 'x'.repeat(1_025), ` ${'x'.repeat(1_025)} `, 7 as never]) {
    assert.throws(
      () =>
        createAitFunctionalMessageDeliveryProvider({
          mtls,
          recipientKey: 'toss-user',
          agreementFailReasons: ['NOT_AGREED', reason],
        }),
      /agreementFailReasons\[1\]: entries must be 1 to 1024 characters once trimmed/u,
    );
  }
  const { mtls: defaults, calls } = fakeMtls([success({ msgCount: 1 })]);
  await createAitFunctionalMessageDeliveryProvider({ mtls: defaults, recipientKey: 'toss-user' })
    .send(request);
  assert.equal(
    calls[0]?.url,
    'https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/messenger/send-message',
  );
  for (const baseUrl of [
    'https://ait.example',
    'https://apps-in-toss-api.toss.im.evil.example',
    'https://not-apps-in-toss-api.toss.im',
    'https://apps-in-toss-api.toss.im:8443',
    'https://user:pass@apps-in-toss-api.toss.im',
  ]) {
    assert.throws(
      () =>
        createAitFunctionalMessageDeliveryProvider({ mtls, recipientKey: 'toss-user', baseUrl }),
      baseUrl.includes('user:pass')
        ? /credential-free HTTPS/u
        : /host must be apps-in-toss-api\.toss\.im/u,
    );
  }
  const { mtls: prefixed, calls: prefixedCalls } = fakeMtls([success({ msgCount: 1 })]);
  await createAitFunctionalMessageDeliveryProvider({
    mtls: prefixed,
    recipientKey: 'toss-user',
    baseUrl: 'https://proxy.example/ait',
    allowUnlistedHost: true,
  }).send(request);
  assert.equal(
    prefixedCalls[0]?.url,
    'https://proxy.example/ait/api-partner/v1/apps-in-toss/messenger/send-message',
  );
}

// The bulk API (send-bulk-message): one call per template, recipients in the body, answered as a whole.
{
  const bulkRequest = (id: string, extra: Partial<AitFunctionalMessageDeliveryRequest> = {}): AitFunctionalMessageDeliveryRequest => ({
    recipient: { kind: 'platform-user', id },
    topic: { id: 'energy-full', mapping: { templateSetCode: 'energy-template' } },
    templateData: { name: id },
    ...extra,
  });
  const bulkSuccess = (pushed: number, msgCount = pushed): Response =>
    json({
      resultType: 'SUCCESS',
      success: {
        msgCount,
        sentPushCount: pushed,
        sentInboxCount: 0,
        sentSmsCount: 0,
        sentAlimtalkCount: 0,
        sentFriendtalkCount: 0,
        detail: {
          ...emptyChannels,
          sentPush: Array.from({ length: pushed }, (_, index) => ({ contentId: `c-${index}` })),
        },
        fail: emptyChannels,
      },
    });
  const { mtls, calls } = fakeMtls([bulkSuccess(3)]);
  const provider = createAitFunctionalMessageDeliveryProvider({ mtls, recipientKey: 'toss-user' });
  const { callKey, ...capability } = provider.bulk;
  assert.deepEqual(capability, {
    maxRecipients: 2_500,
    minRecipients: 50,
    perRecipientOutcomes: false,
    holdWindow: { start: '20:55', end: '08:00', timeZone: 'Asia/Seoul' },
  });
  assert.equal(callKey(bulkRequest('1')), 'energy-template');
  const answers = await provider.sendBatch([
    bulkRequest('101'),
    bulkRequest('9007199254740993'),
    bulkRequest('103'),
    // Not a userKey, an advertising topic, and a template without a code are refused without a call.
    bulkRequest('not-digits'),
    bulkRequest('104', { topic: { id: 'promo', purpose: 'advertising', mapping: { templateSetCode: 'energy-template' } } }),
    bulkRequest('105', { topic: { id: 'energy-full', mapping: {} } }),
  ]);
  assert.deepEqual(
    answers.map((answer) => [answer.status, 'reason' in answer ? answer.reason : undefined]),
    [
      ['accepted', undefined],
      ['accepted', undefined],
      ['accepted', undefined],
      ['rejected', 'recipient'],
      ['rejected', 'configuration'],
      ['rejected', 'configuration'],
    ],
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.url,
    `${defaultAitFunctionalMessageBaseUrl}/api-partner/v1/apps-in-toss/messenger/send-bulk-message`,
  );
  assert.equal(new Headers(calls[0]?.init?.headers).get('x-toss-user-key'), null);
  // A safe integer key is a number; a longer one keeps its digits as a string.
  assert.equal(
    String(calls[0]?.init?.body),
    JSON.stringify({
      templateSetCode: 'energy-template',
      contextList: [
        { userKey: 101, context: { name: '101' } },
        { userKey: '9007199254740993', context: { name: '9007199254740993' } },
        { userKey: 103, context: { name: '103' } },
      ],
    }),
  );

  const anonymous = fakeMtls([bulkSuccess(2)]);
  await createAitFunctionalMessageDeliveryProvider({ mtls: anonymous.mtls, recipientKey: 'anonymous' }).sendBatch(
    [bulkRequest('hash-a'), bulkRequest('hash-b')],
  );
  assert.deepEqual(
    (JSON.parse(String(anonymous.calls[0]?.init?.body)) as { readonly contextList: unknown }).contextList,
    [
      { anonKey: 'hash-a', context: { name: 'hash-a' } },
      { anonKey: 'hash-b', context: { name: 'hash-b' } },
    ],
  );

  // The answer names no recipient: only counts that prove each one, or prove none, decide.
  const outcomes = async (reply: Response, size = 3) => {
    const fake = fakeMtls([reply]);
    const batch = await createAitFunctionalMessageDeliveryProvider({
      mtls: fake.mtls,
      recipientKey: 'toss-user',
      agreementErrorCodes: ['4100'],
    }).sendBatch(Array.from({ length: size }, (_, index) => bulkRequest(String(index + 1))));
    return [...new Set(batch.map((answer) => JSON.stringify(answer)))].map((text) => {
      const answer = JSON.parse(text) as Record<string, unknown>;
      return [answer['status'], answer['reason'] ?? answer['providerCode'], answer['unattributed']];
    });
  };
  assert.deepEqual(await outcomes(bulkSuccess(2)), [['ambiguous', 'BULK_PARTIAL', true]]);
  // Split across channels: 2 by push and 1 by inbox reach 3 recipients once each.
  const split = (push: number, inbox: number): Response =>
    json({
      resultType: 'SUCCESS',
      success: {
        msgCount: push + inbox,
        sentPushCount: push,
        sentInboxCount: inbox,
        sentSmsCount: 0,
        sentAlimtalkCount: 0,
        sentFriendtalkCount: 0,
        detail: emptyChannels,
        fail: emptyChannels,
      },
    });
  assert.deepEqual(
    (await outcomes(split(2, 1))).map((answer) => answer[0]),
    ['accepted'],
  );
  // 2 + 2 for 3 recipients: someone got two messages, so who got none is unknown.
  assert.deepEqual(await outcomes(split(2, 2)), [['ambiguous', 'BULK_PARTIAL', true]]);
  assert.deepEqual(await outcomes(split(1, 1)), [['ambiguous', 'BULK_PARTIAL', true]]);
  assert.deepEqual(await outcomes(bulkSuccess(4)), [['ambiguous', 'BULK_PARTIAL', true]]);
  assert.deepEqual(await outcomes(bulkSuccess(0)), [['rejected', 'recipient', undefined]]);
  assert.deepEqual(await outcomes(fail('4095', { retryAfterSeconds: 30 })), [
    ['rate-limited', '4095', undefined],
  ]);
  assert.deepEqual(await outcomes(json({}, 429, { 'retry-after': '7' })), [
    ['rate-limited', undefined, undefined],
  ]);
  assert.deepEqual(await outcomes(fail('5004')), [['rejected', 'configuration', undefined]]);
  // An agreement code names no player of the batch: it is a recipient refusal, recording no denial.
  assert.deepEqual(await outcomes(fail('4100')), [['rejected', 'recipient', undefined]]);
  assert.deepEqual(await outcomes(json({ resultType: 'INTERNAL_ERROR' }, 500)), [
    ['ambiguous', 'INTERNAL_ERROR', undefined],
  ]);
  assert.deepEqual(await outcomes(json({ resultType: 'SUCCESS', success: {} })), [
    ['ambiguous', 'SUCCESS', undefined],
  ]);
  // Past startWithinMs no call starts: nothing was sent.
  const late = fakeMtls([]);
  assert.deepEqual(
    await createAitFunctionalMessageDeliveryProvider({ mtls: late.mtls, recipientKey: 'toss-user' }).sendBatch(
      [bulkRequest('1'), bulkRequest('2')],
      { startWithinMs: 0 },
    ),
    [
      { status: 'not-sent' },
      { status: 'not-sent' },
    ],
  );
  assert.equal(late.calls.length, 0);
  const transport = fakeMtls([new Error('reset')]);
  assert.deepEqual(
    await createAitFunctionalMessageDeliveryProvider({ mtls: transport.mtls, recipientKey: 'toss-user' }).sendBatch([
      bulkRequest('1'),
    ]),
    [{ status: 'ambiguous', providerCode: 'TRANSPORT_ERROR' }],
  );
}

console.log('Apps in Toss functional message delivery provider tests passed.');
