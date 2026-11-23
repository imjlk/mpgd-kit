import assert from 'node:assert/strict';

import {
  createAppsInTossPartnerApiClient,
  type AppsInTossMutualTlsFetcher,
  type AppsInTossPromotionRecipient,
} from './apps-in-toss-partner-api';

// Request and answer fixtures from the official examples, checked 2026-11-23:
// https://developers-apps-in-toss.toss.im/documentation/common/growth/promotion.md
// ("서버를 통해 프로모션 포인트 지급하기") and https://developers-apps-in-toss.toss.im/api/promotion.md.
const documentedKey = '3oBpxjUgl5r66edcVi7ynHGIjhzr9KOka6FfEKikev0=';
const documentedPromotionCode = '01JPPJ6SB66BQXXDAKRQZ6SZD7';
const baseUrl = 'https://ait-partner.example';
const routes = {
  issueKey: '/api-partner/v1/apps-in-toss/promotion/execute-promotion/get-key',
  execute: '/api-partner/v1/apps-in-toss/promotion/execute-promotion',
  result: '/api-partner/v1/apps-in-toss/promotion/execution-result',
} as const;
const anonymous: AppsInTossPromotionRecipient = { type: 'anonymous', key: 'anon-hash-1' };
const tossUser: AppsInTossPromotionRecipient = { type: 'toss-user', key: '443731104' };
const executeRequest = {
  recipient: anonymous,
  promotionCode: documentedPromotionCode,
  key: documentedKey,
  amount: 10,
};
const alreadyPaid = {
  resultType: 'FAIL',
  error: { errorCode: '4113', reason: '이미 지급/회수된 내역이에요' },
  success: null,
};
const noPayment = {
  resultType: 'FAIL',
  error: { errorCode: '4111', reason: '리워드 지급내역을 찾을 수 없어요' },
  success: null,
};

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function scriptedClient(answers: Response[]) {
  const calls: RecordedCall[] = [];
  const client = createAppsInTossPartnerApiClient({
    baseUrl,
    mtls: {
      async fetch(url, init) {
        calls.push({ url, init });
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error('Missing fake Apps in Toss answer.');
        }
        return answer;
      },
    },
  });
  return { client, calls };
}

// Key issue: one recipient header, the documented empty body, no redirects.
{
  const { client, calls } = scriptedClient([
    Response.json({ resultType: 'SUCCESS', success: { key: documentedKey } }),
    Response.json({ resultType: 'SUCCESS', success: { key: documentedKey } }),
  ]);
  assert.deepEqual(await client.issuePromotionKey({ recipient: anonymous }), {
    key: documentedKey,
  });
  assert.equal(calls[0]?.url, baseUrl + routes.issueKey);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.redirect, 'manual');
  assert.equal(calls[0]?.init?.body, '');
  const anonymousHeaders = new Headers(calls[0]?.init?.headers);
  assert.equal(anonymousHeaders.get('x-anon-key'), 'anon-hash-1');
  assert.equal(anonymousHeaders.has('x-toss-user-key'), false);
  assert.equal(anonymousHeaders.get('content-type'), 'application/json');

  await client.issuePromotionKey({ recipient: tossUser });
  const userHeaders = new Headers(calls[1]?.init?.headers);
  assert.equal(userHeaders.get('x-toss-user-key'), '443731104');
  assert.equal(userHeaders.has('x-anon-key'), false);
}

// Execute: the documented body, and the echoed key must be the one sent.
{
  const { client, calls } = scriptedClient([
    Response.json({ resultType: 'SUCCESS', success: { key: documentedKey } }),
  ]);
  assert.deepEqual(await client.executePromotion(executeRequest), { key: documentedKey });
  assert.equal(calls[0]?.url, baseUrl + routes.execute);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.redirect, 'manual');
  assert.equal(new Headers(calls[0]?.init?.headers).get('x-anon-key'), 'anon-hash-1');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    promotionCode: documentedPromotionCode,
    key: documentedKey,
    amount: 10,
  });
}

// Execution result: the three documented values, and 4111 as NOT_FOUND.
{
  const { client, calls } = scriptedClient([
    Response.json({ resultType: 'SUCCESS', success: 'PENDING' }),
    Response.json({ resultType: 'SUCCESS', success: 'SUCCESS' }),
    Response.json({ resultType: 'SUCCESS', success: 'FAILED' }),
    Response.json(noPayment),
  ]);
  const request = {
    recipient: tossUser,
    promotionCode: documentedPromotionCode,
    key: documentedKey,
  };
  for (const status of ['PENDING', 'SUCCESS', 'FAILED', 'NOT_FOUND'] as const) {
    assert.deepEqual(await client.getPromotionExecutionResult(request), { status });
  }
  assert.equal(calls[0]?.url, baseUrl + routes.result);
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.redirect, 'manual');
  assert.equal(new Headers(calls[0]?.init?.headers).get('x-toss-user-key'), '443731104');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    promotionCode: documentedPromotionCode,
    key: documentedKey,
  });
}

// Answers that are not the documented success shape are errors, never results.
const refusedKeyAnswers: ReadonlyArray<readonly [unknown, string]> = [
  [{ resultType: 'SUCCESS', success: {} }, 'invalid promotion key'],
  [{ resultType: 'SUCCESS', success: null }, 'invalid promotion key'],
  [{ resultType: 'SUCCESS', success: { key: '' } }, 'invalid promotion key'],
  [{ resultType: 'SUCCESS', success: { key: ' padded-key' } }, 'invalid promotion key'],
  [{ resultType: 'SUCCESS', success: { key: 42 } }, 'invalid promotion key'],
];
for (const [answer, message] of refusedKeyAnswers) {
  const { client } = scriptedClient([Response.json(answer)]);
  await assert.rejects(client.issuePromotionKey({ recipient: anonymous }), {
    name: 'AppsInTossPartnerApiError',
    message: new RegExp(message, 'u'),
    status: 200,
  });
}
{
  const { client } = scriptedClient([
    Response.json({
      resultType: 'FAIL',
      error: {
        errorCode: '4095',
        reason: '요청 한도를 초과했습니다.',
        data: { retryAfterSeconds: 3 },
      },
      success: null,
    }),
  ]);
  await assert.rejects(client.issuePromotionKey({ recipient: anonymous }), {
    name: 'AppsInTossPartnerApiError',
    code: '4095',
    status: 200,
  });
}

const refusedExecuteAnswers: ReadonlyArray<
  readonly [Response, { readonly message?: RegExp; readonly code?: string; readonly status: number }]
> = [
  [
    Response.json({ resultType: 'SUCCESS', success: { key: 'another-key=' } }),
    { message: /mismatched promotion key/u, status: 200 },
  ],
  [
    Response.json({ resultType: 'SUCCESS', success: {} }),
    { message: /invalid promotion key/u, status: 200 },
  ],
  [
    Response.json({
      resultType: 'FAIL',
      error: { errorCode: '4112', reason: '프로모션 머니가 부족해요' },
      success: null,
    }),
    { code: '4112', status: 200 },
  ],
  [
    Response.json(
      { resultType: 'SUCCESS', success: { key: documentedKey } },
      { status: 302, headers: { location: 'https://untrusted.example/execute-promotion' } },
    ),
    { status: 302 },
  ],
];
for (const [answer, expected] of refusedExecuteAnswers) {
  const { client, calls } = scriptedClient([answer]);
  await assert.rejects(client.executePromotion(executeRequest), {
    name: 'AppsInTossPartnerApiError',
    ...expected,
  });
  assert.equal(calls.length, 1, 'execute must not retry or follow a redirect on its own');
}

const refusedResultAnswers: ReadonlyArray<
  readonly [Response, { readonly message?: RegExp; readonly code?: string; readonly status: number }]
> = [
  [
    Response.json({ resultType: 'SUCCESS', success: 'DONE' }),
    { message: /unknown promotion execution result/u, status: 200 },
  ],
  [
    Response.json({ resultType: 'SUCCESS', success: { status: 'SUCCESS' } }),
    { message: /unknown promotion execution result/u, status: 200 },
  ],
  // 4111 is a documented HTTP 200 business error; on any other status it proves nothing.
  [Response.json(noPayment, { status: 500 }), { code: '4111', status: 500 }],
  [
    Response.json({ ...noPayment, error: { errorCode: 4111, reason: 'numeric code' } }),
    { status: 200 },
  ],
  [
    Response.json({
      resultType: 'FAIL',
      error: { errorCode: '4100', reason: '프로모션 정보를 찾을 수 없어요' },
      success: null,
    }),
    { code: '4100', status: 200 },
  ],
  [Response.json({ resultType: 'SUCCESS', success: 'SUCCESS' }, { status: 500 }), { status: 500 }],
];
for (const [answer, expected] of refusedResultAnswers) {
  const { client } = scriptedClient([answer]);
  await assert.rejects(
    client.getPromotionExecutionResult({
      recipient: anonymous,
      promotionCode: documentedPromotionCode,
      key: documentedKey,
    }),
    { name: 'AppsInTossPartnerApiError', ...expected },
  );
}

// Inputs the API would refuse are refused before anything is sent.
{
  const { client, calls } = scriptedClient([]);
  for (const amount of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(client.executePromotion({ ...executeRequest, amount }), {
      name: 'TypeError',
      message: /amount must be a positive safe integer/u,
    });
  }
  for (const key of ['', ' padded-key', 'line\nbreak', 'k'.repeat(4_097)]) {
    await assert.rejects(client.executePromotion({ ...executeRequest, key }), TypeError);
    await assert.rejects(
      client.getPromotionExecutionResult({
        recipient: anonymous,
        promotionCode: documentedPromotionCode,
        key,
      }),
      TypeError,
    );
  }
  await assert.rejects(
    client.executePromotion({ ...executeRequest, promotionCode: ' ' }),
    TypeError,
  );
  await assert.rejects(
    client.issuePromotionKey({ recipient: { type: 'anonymous', key: ' ' } }),
    TypeError,
  );
  await assert.rejects(
    client.issuePromotionKey({
      recipient: { type: 'player', key: 'player-1' } as unknown as AppsInTossPromotionRecipient,
    }),
    TypeError,
  );
  assert.equal(calls.length, 0);
}

/**
 * A partner API that follows the documented promotion rules: key issue
 * answers a new key on every call, a key pays at most once and a used key
 * answers 4113, and execution-result answers 4111 for a key with no payment.
 * A queued fault changes the next execute answer: the request is lost before
 * Toss sees it, or Toss pays and the answer is lost, is held until the call
 * is aborted (by the client's timeout or the caller, through `hooks.onHold`),
 * or is an HTTP 500.
 */
function createDocumentedPromotionApi() {
  type Fault = 'request-lost' | 'answer-lost' | 'answer-held' | 'answer-internal-error';
  const issuedKeys: string[] = [];
  const payments = new Map<string, number>();
  const faults: Fault[] = [];
  const routesCalled: string[] = [];
  const hooks: { onHold?: () => void } = {};
  const mtls: AppsInTossMutualTlsFetcher = {
    async fetch(url, init) {
      const path = new URL(url).pathname;
      routesCalled.push(path);
      const body: unknown = typeof init?.body === 'string' && init.body.length > 0
        ? JSON.parse(init.body)
        : undefined;
      if (path === routes.issueKey) {
        const key = `issued-key-${String(issuedKeys.length + 1)}=`;
        issuedKeys.push(key);
        return Response.json({ resultType: 'SUCCESS', success: { key } });
      }
      const { key, amount } = body as { readonly key: string; readonly amount?: number };
      if (path === routes.result) {
        return Response.json(
          payments.has(key) ? { resultType: 'SUCCESS', success: 'SUCCESS' } : noPayment,
        );
      }
      assert.equal(path, routes.execute);
      const fault = faults.shift();
      if (fault === 'request-lost') {
        throw new TypeError('fetch failed: the connection closed before the request was sent');
      }
      let answer: Response;
      if (payments.has(key)) {
        answer = Response.json(alreadyPaid);
      } else {
        payments.set(key, amount ?? Number.NaN);
        answer = Response.json({ resultType: 'SUCCESS', success: { key } });
      }
      if (fault === 'answer-lost') {
        throw new TypeError('fetch failed: the connection closed after Toss applied the request');
      }
      if (fault === 'answer-held') {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted === true) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          hooks.onHold?.();
        });
      }
      if (fault === 'answer-internal-error') {
        return Response.json(
          {
            resultType: 'INTERNAL_ERROR',
            error: { errorCode: 'INTERNAL_ERROR', reason: 'internal error' },
            success: null,
          },
          { status: 500 },
        );
      }
      return answer;
    },
  };
  return { mtls, issuedKeys, payments, faults, routesCalled, hooks };
}

// The caller protocol every scenario follows: one key per grant, stored
// before the first execute; every execute failure is settled from
// execution-result; a retry reuses the stored key and never issues another.
const grant = { recipient: anonymous, promotionCode: documentedPromotionCode } as const;

// Toss paid, but the answer was lost. The retry with the same key cannot pay
// twice: Toss answers 4113, and the execution result settles the grant.
{
  const api = createDocumentedPromotionApi();
  const client = createAppsInTossPartnerApiClient({ baseUrl, mtls: api.mtls });
  const { key } = await client.issuePromotionKey({ recipient: grant.recipient });
  api.faults.push('answer-lost');
  await assert.rejects(client.executePromotion({ ...grant, key, amount: 10 }), {
    name: 'AppsInTossPartnerApiError',
    code: 'TRANSPORT_ERROR',
  });
  await assert.rejects(client.executePromotion({ ...grant, key, amount: 10 }), {
    name: 'AppsInTossPartnerApiError',
    code: '4113',
    status: 200,
  });
  assert.deepEqual(await client.getPromotionExecutionResult({ ...grant, key }), {
    status: 'SUCCESS',
  });
  assert.deepEqual([...api.payments.values()], [10]);
  assert.deepEqual(api.issuedKeys, [key]);
  assert.deepEqual(api.routesCalled, [
    routes.issueKey,
    routes.execute,
    routes.execute,
    routes.result,
  ]);
}

// The request was lost before Toss saw it. Once the caller has backed off
// (this fake holds no call in progress to wait for), NOT_FOUND (4111) lets the
// grant execute again with the same key, which pays once.
{
  const api = createDocumentedPromotionApi();
  const client = createAppsInTossPartnerApiClient({ baseUrl, mtls: api.mtls });
  const { key } = await client.issuePromotionKey({ recipient: grant.recipient });
  api.faults.push('request-lost');
  await assert.rejects(client.executePromotion({ ...grant, key, amount: 10 }), {
    name: 'AppsInTossPartnerApiError',
    code: 'TRANSPORT_ERROR',
  });
  assert.deepEqual(await client.getPromotionExecutionResult({ ...grant, key }), {
    status: 'NOT_FOUND',
  });
  assert.deepEqual(await client.executePromotion({ ...grant, key, amount: 10 }), { key });
  assert.deepEqual(await client.getPromotionExecutionResult({ ...grant, key }), {
    status: 'SUCCESS',
  });
  assert.deepEqual([...api.payments.values()], [10]);
  assert.deepEqual(api.issuedKeys, [key]);
}

// Toss paid, then the client timed out, the caller aborted, or Toss answered
// HTTP 500. Each is an ambiguous rejection; the result shows the one payment,
// and a retry with the same key is answered 4113.
const ambiguousEndings = [
  { ending: 'timeout', fault: 'answer-held', code: 'TIMEOUT', status: 0 },
  { ending: 'caller-abort', fault: 'answer-held', code: 'ABORTED', status: 0 },
  { ending: 'http-500', fault: 'answer-internal-error', code: 'INTERNAL_ERROR', status: 500 },
] as const;
for (const { ending, fault, code, status } of ambiguousEndings) {
  const api = createDocumentedPromotionApi();
  const client = createAppsInTossPartnerApiClient({ baseUrl, mtls: api.mtls });
  // Only the held call gets the short timeout, so an immediate answer never races it.
  const executingClient = ending === 'timeout'
    ? createAppsInTossPartnerApiClient({ baseUrl, mtls: api.mtls, timeoutMs: 50 })
    : client;
  const caller = new AbortController();
  if (ending === 'caller-abort') {
    api.hooks.onHold = () => caller.abort(new Error('The caller gave up.'));
  }
  const { key } = await client.issuePromotionKey({ recipient: grant.recipient });
  api.faults.push(fault);
  await assert.rejects(
    executingClient.executePromotion({ ...grant, key, amount: 10, signal: caller.signal }),
    { name: 'AppsInTossPartnerApiError', code, status },
  );
  assert.deepEqual(await client.getPromotionExecutionResult({ ...grant, key }), {
    status: 'SUCCESS',
  });
  await assert.rejects(client.executePromotion({ ...grant, key, amount: 10 }), { code: '4113' });
  assert.deepEqual([...api.payments.values()], [10]);
  assert.deepEqual(api.issuedKeys, [key]);
}
