import assert from 'node:assert/strict';

import { PlatformOperationError } from '@mpgd/platform';
import {
  NotificationError,
  notificationsProtocolVersion,
  type NotificationEvent,
  type NotificationProvider,
} from '@mpgd/platform/notifications';

import { validNotificationsV2Exchanges } from './fixtures';
import {
  isThrownInstance,
  readThrownField,
  thrownMessage,
  type BridgeNotificationsEvent,
  type BridgeRequest,
  type BridgeResponse,
} from './index';
import {
  createNotificationsBackendBridgeHandler,
  createNotificationsV2BridgeHandler,
  notificationsBackendBridgeHostCodes,
  readBridgeNotificationsHostCode,
  type NotificationsBackendBridgeServer,
} from './notifications';

function request(method: string, payload: unknown, id = `${method}:test`): BridgeRequest {
  return {
    id,
    method: method as BridgeRequest['method'],
    payload,
    meta: { target: 'web', appVersion: '1', buildId: 'test', sentAt: '2026-10-21T00:00:00Z' },
  };
}

function errorOf(response: BridgeResponse): { readonly code: string; readonly message: string; readonly retryable: boolean } {
  assert.equal(response.ok, false, JSON.stringify(response));
  if (response.ok) {
    throw new Error('unreachable');
  }
  return response.error;
}

const exchanges = Object.fromEntries(
  validNotificationsV2Exchanges.map((exchange) => [exchange.method, exchange]),
) as unknown as Record<string, { readonly payload: unknown; readonly result: Record<string, unknown> }>;

function exchangeOf(method: string): { readonly payload: unknown; readonly result: Record<string, unknown> } {
  const exchange = exchanges[method];
  if (exchange === undefined) {
    throw new Error(`No fixture for ${method}.`);
  }
  return exchange;
}

const protocol = { protocol: 'mpgd.notifications.v2' } as const;
const capabilities = exchangeOf(
  'notifications.v2.getCapabilities',
).result['capabilities'] as Awaited<
  ReturnType<NotificationProvider['getCapabilities']>
>;

/** A provider that answers every method with its fixture answer and records the calls. */
function fullProvider(calls: string[] = []): NotificationProvider {
  const answer = (method: string) => exchangeOf(method).result;
  return {
    provider: 'fcm',
    async getCapabilities() {
      calls.push('getCapabilities');
      return capabilities;
    },
    async getPermission() {
      calls.push('getPermission');
      return answer('notifications.v2.getPermission') as never;
    },
    async requestPermission() {
      calls.push('requestPermission');
      return answer('notifications.v2.requestPermission') as never;
    },
    async revokePermission() {
      calls.push('revokePermission');
      return answer('notifications.v2.revokePermission') as never;
    },
    async register() {
      calls.push('register');
      return answer('notifications.v2.register')['registration'] as never;
    },
    async scheduleLocal() {
      calls.push('scheduleLocal');
      return answer('notifications.v2.scheduleLocal') as never;
    },
    async cancelLocal() {
      calls.push('cancelLocal');
    },
    async listLocal() {
      calls.push('listLocal');
      return answer('notifications.v2.listLocal')['pending'] as never;
    },
    async openSettings() {
      calls.push('openSettings');
      return 'opened';
    },
    subscribe: () => () => {},
  };
}

const minimal: NotificationProvider = {
  provider: 'fixture',
  getCapabilities: async () => capabilities,
  getPermission: async ({ topics }) => ({
    topics: Object.fromEntries(topics.map((topic) => [topic, 'unsupported' as const])),
  }),
  requestPermission: async () => ({ snapshot: { topics: {} }, outcomes: {} }),
  subscribe: () => () => {},
};

// Every method answers its fixture answer, checked on the way out.
{
  const calls: string[] = [];
  const handler = createNotificationsV2BridgeHandler({ provider: fullProvider(calls) });
  for (const exchange of validNotificationsV2Exchanges) {
    const response = await handler.request(request(exchange.method, exchange.payload));
    assert.deepEqual(
      response,
      {
        id: `${exchange.method}:test`,
        ok: true,
        data: exchange.method === 'notifications.v2.getCapabilities'
          ? { protocolVersion: notificationsProtocolVersion, provider: 'fcm', capabilities }
          : exchange.result,
      },
      exchange.method,
    );
  }
  assert.deepEqual(calls, [
    'getCapabilities',
    'getPermission',
    'requestPermission',
    'revokePermission',
    'register',
    'scheduleLocal',
    'cancelLocal',
    'listLocal',
    'openSettings',
  ]);
}

// A method outside notifications v2, an inherited key included, answers UNSUPPORTED_METHOD.
{
  const handler = createNotificationsV2BridgeHandler({ provider: minimal });
  for (const method of [
    'storage.load',
    'commerce.v2.getCapabilities',
    'constructor',
    'notifications.v2.unknown',
  ]) {
    assert.equal(
      errorOf(await handler.request(request(method, {}))).code,
      'UNSUPPORTED_METHOD',
      method,
    );
  }
}

// A method the provider lacks answers NOTIFICATIONS_UNSUPPORTED; openSettings answers unavailable.
{
  const handler = createNotificationsV2BridgeHandler({ provider: minimal, label: 'Fixture' });
  for (const method of [
    'notifications.v2.revokePermission',
    'notifications.v2.register',
    'notifications.v2.scheduleLocal',
    'notifications.v2.cancelLocal',
    'notifications.v2.listLocal',
  ]) {
    const error = errorOf(await handler.request(request(method, exchangeOf(method).payload)));
    assert.equal(error.code, 'NOTIFICATIONS_UNSUPPORTED', method);
    assert.equal(error.retryable, false);
    assert.equal(error.message, `The Fixture notifications provider does not implement ${method}.`);
  }
  assert.deepEqual(await handler.request(request('notifications.v2.openSettings', protocol)), {
    id: 'notifications.v2.openSettings:test',
    ok: true,
    data: { status: 'unavailable' },
  });
  // Without a label the message names no host.
  const unlabelled = createNotificationsV2BridgeHandler({ provider: minimal });
  assert.equal(
    errorOf(await unlabelled.request(request('notifications.v2.listLocal', protocol))).message,
    'The notifications provider does not implement notifications.v2.listLocal.',
  );
  // An empty label counts as none.
  const empty = createNotificationsV2BridgeHandler({ provider: minimal, label: '' });
  assert.equal(
    errorOf(await empty.request(request('notifications.v2.listLocal', protocol))).message,
    'The notifications provider does not implement notifications.v2.listLocal.',
  );
}

// registerOptional answers no address for a provider without register, and only then.
{
  const optional = createNotificationsV2BridgeHandler({
    provider: minimal,
    registerOptional: true,
  });
  assert.deepEqual(await optional.request(request('notifications.v2.register', protocol)), {
    id: 'notifications.v2.register:test',
    ok: true,
    data: { registration: null },
  });
  // The payload is still checked first.
  assert.equal(
    errorOf(await optional.request(request('notifications.v2.register', {}))).code,
    'NOTIFICATIONS_INVALID_INPUT',
  );
  // A provider that has register is called, and its answer is still checked.
  const broken = createNotificationsV2BridgeHandler({
    provider: { ...minimal, register: async () => undefined as never },
    registerOptional: true,
  });
  assert.equal(
    errorOf(await broken.request(request('notifications.v2.register', protocol))).code,
    'NOTIFICATIONS_CONFIGURATION_REQUIRED',
  );
}

// A payload the contract rejects never reaches the provider and is not reported.
{
  const calls: string[] = [];
  const reported: unknown[] = [];
  const handler = createNotificationsV2BridgeHandler({
    provider: fullProvider(calls),
    onError: (error) => reported.push(error),
  });
  for (const [method, payload] of [
    ['notifications.v2.getCapabilities', {}],
    ['notifications.v2.getPermission', { topics: 'a' }],
    ['notifications.v2.getPermission', { topics: ['a'], extra: true }],
    ['notifications.v2.requestPermission', { topics: [] }],
    ['notifications.v2.revokePermission', null],
    ['notifications.v2.register', { protocol: 'mpgd.commerce.v2' }],
    [
      'notifications.v2.scheduleLocal',
      {
        ...(exchangeOf('notifications.v2.scheduleLocal').payload as object),
        route: 'https://evil.example',
      },
    ],
    ['notifications.v2.cancelLocal', {}],
    ['notifications.v2.listLocal', undefined],
    ['notifications.v2.openSettings', []],
  ] as const) {
    const error = errorOf(await handler.request(request(method, payload)));
    assert.equal(error.code, 'NOTIFICATIONS_INVALID_INPUT', method);
    assert.equal(error.retryable, false);
    assert.match(
      error.message,
      new RegExp(`^${method.replaceAll('.', '\\.')} payload is invalid: `, 'u'),
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(reported, []);
}

// An answer the contract rejects is NOTIFICATIONS_CONFIGURATION_REQUIRED, not retryable, and reported.
{
  const reported: string[] = [];
  const handler = createNotificationsV2BridgeHandler({
    provider: {
      ...minimal,
      getPermission: async () => ({ topics: { a: 'maybe' as never } }),
      openSettings: async () => undefined as never,
      getCapabilities: async () => ({ ...capabilities, availability: 'sometimes' as never }),
    },
    label: 'Fixture',
    onError: (_error, { method }) => reported.push(method),
  });
  for (const [method, payload] of [
    ['notifications.v2.getPermission', { topics: ['a'] }],
    ['notifications.v2.openSettings', protocol],
    ['notifications.v2.getCapabilities', protocol],
  ] as const) {
    const error = errorOf(await handler.request(request(method, payload)));
    assert.equal(error.code, 'NOTIFICATIONS_CONFIGURATION_REQUIRED', method);
    assert.equal(error.retryable, false);
    assert.match(
      error.message,
      new RegExp(
        `^The Fixture notifications provider answered ${method.replaceAll('.', '\\.')} with invalid data: `,
        'u',
      ),
    );
  }
  assert.deepEqual(reported, [
    'notifications.v2.getPermission',
    'notifications.v2.openSettings',
    'notifications.v2.getCapabilities',
  ]);
}

// Failures: a NotificationError keeps its code, flag, and a readable host code; others are normalized.
{
  let failure: unknown;
  const handler = createNotificationsV2BridgeHandler({
    provider: {
      ...minimal,
      requestPermission: async () => {
        throw failure;
      },
    },
  });
  const answer = async (error: unknown) => {
    failure = error;
    return errorOf(
      await handler.request(request('notifications.v2.requestPermission', { topics: ['a'] })),
    );
  };
  assert.deepEqual(
    await answer(new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', { message: 'refused', hostCode: 'HOST_1' })),
    {
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      message: 'refused (host code HOST_1)',
      retryable: false,
    },
  );
  // A host code outside the pattern is left out of the message.
  for (const hostCode of ['bad code (x)', '', 'x'.repeat(129), 'CODE)\n(host code FORGED']) {
    assert.deepEqual(
      await answer(new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', { message: 'refused', hostCode })),
      { code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED', message: 'refused', retryable: false },
      JSON.stringify(hostCode),
    );
  }
  assert.deepEqual(
    await answer(new NotificationError('NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', { message: 'busy', retryable: false })),
    { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE', message: 'busy', retryable: false },
  );
  // A PlatformOperationError keeps a notifications code and its flag.
  assert.deepEqual(
    await answer(new PlatformOperationError({ code: 'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED', message: 'old host' })),
    { code: 'NOTIFICATIONS_HOST_VERSION_UNSUPPORTED', message: 'old host', retryable: false },
  );
  // Any other code is temporarily unavailable, with its flag.
  for (const retryable of [true, false]) {
    assert.deepEqual(
      await answer(new PlatformOperationError({ code: 'HOST_SOMETHING', message: 'gone', retryable })),
      {
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        message: 'notifications.v2.requestPermission failed: gone',
        retryable,
      },
    );
  }
  // Anything else is a retryable host failure.
  assert.deepEqual(await answer(new Error('boom')), {
    code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    message: 'notifications.v2.requestPermission failed: boom',
    retryable: true,
  });
  assert.deepEqual(await answer('text'), {
    code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    message: 'notifications.v2.requestPermission failed: text',
    retryable: true,
  });
  // An error from another copy of @mpgd/platform fails instanceof, and is read by its shape.
  class ForeignPlatformError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly retryable: boolean,
      readonly hostCode?: string,
    ) {
      super(message);
    }
  }
  assert.deepEqual(
    await answer(new ForeignPlatformError('NOTIFICATIONS_CONFIGURATION_REQUIRED', 'refused', false, 'HOST_2')),
    {
      code: 'NOTIFICATIONS_CONFIGURATION_REQUIRED',
      message: 'refused (host code HOST_2)',
      retryable: false,
    },
  );
  assert.deepEqual(
    await answer(new ForeignPlatformError('NOTIFICATIONS_UNSUPPORTED', 'no', false, 'bad code')),
    { code: 'NOTIFICATIONS_UNSUPPORTED', message: 'no', retryable: false },
  );
  // Another code keeps its retryable flag, with the text of an unnormalized failure.
  assert.deepEqual(await answer(new ForeignPlatformError('HOST_SOMETHING', 'gone', false)), {
    code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    message: 'notifications.v2.requestPermission failed: gone',
    retryable: false,
  });
  // A shape without a boolean flag or with a code that is not a platform code is not one.
  assert.deepEqual(
    await answer(Object.assign(new Error('raw'), { code: 'NOTIFICATIONS_UNSUPPORTED' })),
    {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: raw',
      retryable: true,
    },
  );
  assert.deepEqual(
    await answer(Object.assign(new Error('reset'), { code: 'ECONNRESET', retryable: false })),
    {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: reset',
      retryable: false,
    },
  );
}

// Shapes that are not Error instances, with and without unexpectedFailureMessage.
{
  let failure: unknown;
  const answer = async (unexpectedFailureMessage?: (method: string) => string) => {
    const handler = createNotificationsV2BridgeHandler({
      provider: {
        ...minimal,
        requestPermission: async () => {
          throw failure;
        },
      },
      ...(unexpectedFailureMessage === undefined ? {} : { unexpectedFailureMessage }),
    });
    return errorOf(
      await handler.request(request('notifications.v2.requestPermission', { topics: ['a'] })),
    );
  };
  const redact = (method: string) => `${method} failed on the host.`;
  // A plain object keeps its message text, unless the host redacts it.
  failure = { code: 'HOST_SOMETHING', message: 'internal detail', retryable: false };
  assert.deepEqual(await answer(), {
    code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    message: 'notifications.v2.requestPermission failed: internal detail',
    retryable: false,
  });
  assert.deepEqual(await answer(redact), {
    code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    message: 'notifications.v2.requestPermission failed on the host.',
    retryable: false,
  });
  // A notifications code is the provider's own answer: its message crosses, redaction or not.
  failure = { code: 'NOTIFICATIONS_UNSUPPORTED', message: 'no reminders here', retryable: false };
  assert.deepEqual(await answer(redact), {
    code: 'NOTIFICATIONS_UNSUPPORTED',
    message: 'no reminders here',
    retryable: false,
  });
  // Without a string message, a fixed one.
  failure = { code: 'NOTIFICATIONS_UNSUPPORTED', message: 42, retryable: false, hostCode: 7 };
  assert.deepEqual(await answer(), {
    code: 'NOTIFICATIONS_UNSUPPORTED',
    message: 'notifications.v2.requestPermission failed.',
    retryable: false,
  });
  // A thrown object whose fields throw still gets an answer: the field counts as missing.
  failure = {
    get code(): string {
      throw new Error('hostile getter');
    },
  };
  assert.deepEqual(await answer(), {
    code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    message: 'notifications.v2.requestPermission failed: [object Object]',
    retryable: true,
  });
}

// The shared thrown-value helpers never throw.
{
  const hostile = (): never => {
    throw new Error('hostile read');
  };
  const trapped = new Proxy({}, { get: hostile, getPrototypeOf: hostile });
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  assert.equal(readThrownField({ code: 'X' }, 'code'), 'X');
  assert.equal(readThrownField(null, 'code'), undefined);
  assert.equal(readThrownField('text', 'length'), undefined);
  assert.equal(
    readThrownField(
      {
        get code(): string {
          return hostile();
        },
      },
      'code',
    ),
    undefined,
  );
  assert.equal(readThrownField(trapped, 'code'), undefined);
  assert.equal(readThrownField(revocable.proxy, 'code'), undefined);
  assert.equal(isThrownInstance(new TypeError('x'), Error), true);
  assert.equal(isThrownInstance({}, Error), false);
  assert.equal(isThrownInstance(trapped, Error), false);
  assert.equal(isThrownInstance(revocable.proxy, Error), false);
  assert.equal(thrownMessage(new Error('plain')), 'plain');
  assert.equal(thrownMessage({ message: 'shaped' }), 'shaped');
  assert.equal(thrownMessage('text'), 'text');
  assert.equal(thrownMessage(Symbol('s')), 'Symbol(s)');
  for (const value of [
    { toString: hostile },
    Object.create(null) as unknown,
    trapped,
    revocable.proxy,
  ]) {
    assert.equal(thrownMessage(value), 'a failure that cannot be read');
  }
}

// Hostile thrown values: getters, toString, and Proxy traps that throw never
// reject the request, and a readable code and flag still cross.
{
  const hostile = (): never => {
    throw new Error('hostile read');
  };
  /** A Proxy whose every trap throws, `getPrototypeOf` (so `instanceof`) included. */
  const trapped = new Proxy(
    {},
    {
      get: hostile,
      getPrototypeOf: hostile,
      has: hostile,
      ownKeys: hostile,
      getOwnPropertyDescriptor: hostile,
    },
  );
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const unreadableMessage = new Error('hidden');
  Object.defineProperty(unreadableMessage, 'message', { get: hostile });
  const cases: readonly (readonly [string, unknown, { readonly code: string; readonly message: string; readonly retryable: boolean }])[] = [
    ['null', null, {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: null',
      retryable: true,
    }],
    ['undefined', undefined, {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: undefined',
      retryable: true,
    }],
    ['a string', 'plain text', {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: plain text',
      retryable: true,
    }],
    ['a symbol', Symbol('thrown'), {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: Symbol(thrown)',
      retryable: true,
    }],
    ['a throwing toString', { toString: hostile }, {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: a failure that cannot be read',
      retryable: true,
    }],
    ['an object without a prototype', Object.create(null) as unknown, {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: a failure that cannot be read',
      retryable: true,
    }],
    ['an Error whose message getter throws', unreadableMessage, {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: a failure that cannot be read',
      retryable: true,
    }],
    // The code and flag were readable: they cross, with a fixed message.
    ['a readable code with a throwing message getter', {
      code: 'NOTIFICATIONS_UNSUPPORTED',
      retryable: false,
      get message(): string {
        return hostile();
      },
      get hostCode(): string {
        return hostile();
      },
    }, {
      code: 'NOTIFICATIONS_UNSUPPORTED',
      message: 'notifications.v2.requestPermission failed.',
      retryable: false,
    }],
    ['a readable flag with a throwing code getter', {
      get code(): string {
        return hostile();
      },
      retryable: false,
      message: 'shown',
    }, {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: shown',
      retryable: true,
    }],
    ['a Proxy whose traps throw', trapped, {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: a failure that cannot be read',
      retryable: true,
    }],
    ['a revoked Proxy', revocable.proxy, {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: a failure that cannot be read',
      retryable: true,
    }],
  ];
  for (const [name, thrown, expected] of cases) {
    // With and without onError: report() checks the class too, and must not throw either.
    for (const withHook of [false, true]) {
      const reported: unknown[] = [];
      const handler = createNotificationsV2BridgeHandler({
        provider: {
          ...minimal,
          requestPermission: async () => {
            throw thrown;
          },
        },
        ...(withHook ? { onError: (error: unknown) => reported.push(error) } : {}),
      });
      const response = await handler.request(
        request('notifications.v2.requestPermission', { topics: ['a'] }),
      );
      assert.deepEqual(errorOf(response), expected, `${name}${withHook ? ' with onError' : ''}`);
      assert.equal(reported.length, withHook ? 1 : 0, name);
      if (withHook) {
        assert.equal(reported[0], thrown, name);
      }
    }
  }

  // A Proxy thrown by a backend, under the backend handler's onError.
  const backendReported: unknown[] = [];
  const backendHandler = createNotificationsBackendBridgeHandler({
    backend: {
      session: () => ({ id: 's', player: 't2_a' }),
      listConsent: async () => {
        throw trapped;
      },
    } as unknown as NotificationsBackendBridgeServer<{ readonly id: string; readonly player: string }>,
    onError: (error) => backendReported.push(error),
  });
  assert.deepEqual(
    errorOf(await backendHandler.request(
      request('notifications.backend.listConsent', { expectedPlayer: 't2_a' }),
    )),
    {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.backend.listConsent failed on the host.',
      retryable: true,
    },
  );
  assert.deepEqual(backendReported, [trapped]);
}

// An unexpectedFailureMessage that throws or answers a non-string is reported;
// the failure crosses with a fixed message and keeps its flag.
{
  for (const [name, build] of [
    [
      'throws',
      (): string => {
        throw new Error('message builder broke');
      },
    ],
    ['answers a non-string', (() => 42) as unknown as () => string],
  ] as const) {
    const reported: unknown[] = [];
    const handler = createNotificationsV2BridgeHandler({
      provider: {
        ...minimal,
        requestPermission: async () => {
          throw { code: 'HOST_SOMETHING', message: 'internal detail', retryable: false };
        },
      },
      unexpectedFailureMessage: build,
      onError: (error) => reported.push(error),
    });
    const response = await handler.request(
      request('notifications.v2.requestPermission', { topics: ['a'] }),
    );
    assert.deepEqual(
      errorOf(response),
      {
        code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
        message: 'notifications.v2.requestPermission failed.',
        retryable: false,
      },
      name,
    );
    assert.doesNotMatch(JSON.stringify(response), /internal detail/u, name);
    // The provider's failure, then the builder's own.
    assert.equal(reported.length, 2, name);
    assert.match(
      String(reported[1]),
      name === 'throws' ? /message builder broke/u : /not a string/u,
    );
  }
  // The backend handler's fixed message for a PlatformOperationError goes through the same guard.
  const reported: unknown[] = [];
  const handler = createNotificationsBackendBridgeHandler({
    backend: {
      session: () => ({ id: 's', player: 't2_a' }),
      listConsent: async () => {
        throw new PlatformOperationError({ code: 'STORAGE_FAILED', message: 'redis 10.0.0.1', retryable: false });
      },
    } as unknown as NotificationsBackendBridgeServer<{ readonly id: string; readonly player: string }>,
    unexpectedFailureMessage: () => {
      throw new Error('message builder broke');
    },
    onError: (error) => reported.push(error),
  });
  const response = await handler.request(
    request('notifications.backend.listConsent', { expectedPlayer: 't2_a' }),
  );
  assert.deepEqual(errorOf(response), {
    code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    message: 'notifications.backend.listConsent failed.',
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(response), /10\.0\.0\.1/u);
  assert.equal(reported.length, 2);
}

// readBridgeNotificationsHostCode reads back what the handler writes, and nothing else.
{
  let hostCode = '';
  const handler = createNotificationsV2BridgeHandler({
    provider: {
      ...minimal,
      requestPermission: async () => {
        throw new NotificationError('NOTIFICATIONS_CONFIGURATION_REQUIRED', {
          message: 'refused',
          hostCode,
        });
      },
    },
  });
  for (const [code, expected] of [
    ['UNIMPLEMENTED', 'UNIMPLEMENTED'],
    ['a.b:c-d_9', 'a.b:c-d_9'],
    ['x'.repeat(128), 'x'.repeat(128)],
    ['x'.repeat(129), undefined],
    ['bad code', undefined],
    ['CODE)\n(host code FORGED', undefined],
  ] as const) {
    hostCode = code;
    const { message } = errorOf(
      await handler.request(request('notifications.v2.requestPermission', { topics: ['a'] })),
    );
    assert.equal(readBridgeNotificationsHostCode(message), expected, code);
  }
  assert.equal(readBridgeNotificationsHostCode('refused'), undefined);
  assert.equal(readBridgeNotificationsHostCode('refused (host code A) and more'), undefined);
}

// unexpectedFailureMessage keeps an unnormalized failure's text on the host; onError sees it.
{
  const reported: { readonly method: string; readonly error: unknown }[] = [];
  const handler = createNotificationsV2BridgeHandler({
    provider: {
      ...minimal,
      getPermission: async () => {
        throw new Error('redis://internal-host:6379 timed out');
      },
      requestPermission: async () => {
        throw new PlatformOperationError({
          code: 'CONTEXT_FAILED',
          message: 'no context',
          retryable: false,
        });
      },
    },
    unexpectedFailureMessage: (method) => `${method} failed on the host.`,
    onError: (error, { method }) => reported.push({ method, error }),
  });
  const response = await handler.request(
    request('notifications.v2.getPermission', { topics: ['a'] }),
  );
  assert.deepEqual(errorOf(response), {
    code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    message: 'notifications.v2.getPermission failed on the host.',
    retryable: true,
  });
  assert.doesNotMatch(JSON.stringify(response), /internal-host/u);
  // A PlatformOperationError is the provider's own normalized failure and keeps its message.
  assert.deepEqual(
    errorOf(await handler.request(request('notifications.v2.requestPermission', { topics: ['a'] }))),
    {
      code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
      message: 'notifications.v2.requestPermission failed: no context',
      retryable: false,
    },
  );
  assert.equal(reported.length, 2);
  assert.equal(reported[0]?.method, 'notifications.v2.getPermission');
  assert.match(String(reported[0]?.error), /internal-host/u);
  // An unsupported method and a method outside v2 are reported only when they are failures the handler answers.
  await handler.request(request('notifications.v2.listLocal', protocol));
  await handler.request(request('storage.load', {}));
  assert.deepEqual(
    reported.map((entry) => entry.method),
    [
      'notifications.v2.getPermission',
      'notifications.v2.requestPermission',
      'notifications.v2.listLocal',
    ],
  );
}

// A hook that throws or rejects changes nothing.
{
  for (const onError of [
    () => {
      throw new Error('log sink down');
    },
    (() => Promise.reject(new Error('log sink down'))) as unknown as () => void,
  ]) {
    const handler = createNotificationsV2BridgeHandler({
      provider: {
        ...minimal,
        getPermission: async () => {
          throw new Error('boom');
        },
      },
      onError,
    });
    assert.equal(
      errorOf(await handler.request(request('notifications.v2.getPermission', { topics: ['a'] }))).code,
      'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE',
    );
  }
}

// A hook that returns a thenable gets a rejection handler, so a rejecting one is never unhandled.
{
  const handlers: unknown[] = [];
  const handler = createNotificationsV2BridgeHandler({
    provider: {
      ...minimal,
      getPermission: async () => {
        throw new Error('boom');
      },
    },
    onError: (() => ({
      then(_onFulfilled: unknown, onRejected: unknown) {
        handlers.push(onRejected);
      },
    })) as unknown as () => void,
  });
  await handler.request(request('notifications.v2.getPermission', { topics: ['a'] }));
  assert.equal(handlers.length, 1);
  assert.equal(typeof handlers[0], 'function');
}

// A provider whose methods read `this` is called on itself.
{
  class Provider implements NotificationProvider {
    readonly provider = 'fixture';
    private readonly pending = [{ key: 'k', topic: 't', fireAt: '2026-10-21T09:00:00+09:00' }];
    async getCapabilities() {
      return capabilities;
    }
    async getPermission() {
      return { topics: {} };
    }
    async requestPermission() {
      return { snapshot: { topics: {} }, outcomes: {} };
    }
    async listLocal() {
      return this.pending;
    }
    subscribe() {
      return () => {};
    }
  }
  const handler = createNotificationsV2BridgeHandler({ provider: new Provider() });
  assert.deepEqual(await handler.request(request('notifications.v2.listLocal', protocol)), {
    id: 'notifications.v2.listLocal:test',
    ok: true,
    data: { pending: [{ key: 'k', topic: 't', fireAt: '2026-10-21T09:00:00+09:00' }] },
  });
}

// Events: numbered per handler from 0, the provider attached for the first listener only.
{
  const emitters: ((event: NotificationEvent) => void)[] = [];
  let subscribes = 0;
  const provider: NotificationProvider = {
    ...minimal,
    subscribe(listener) {
      subscribes += 1;
      emitters.push(listener);
      // A buffered cold open reaches the first listener as it attaches.
      listener({ type: 'opened', channel: 'remote', source: 'cold', route: '/' });
      return () => {};
    },
  };
  const handler = createNotificationsV2BridgeHandler({ provider });
  assert.equal(subscribes, 0);
  const first: BridgeNotificationsEvent[] = [];
  const second: BridgeNotificationsEvent[] = [];
  handler.subscribe((envelope) => first.push(envelope));
  handler.subscribe((envelope) => second.push(envelope));
  assert.equal(subscribes, 1);
  emitters[0]?.({ type: 'received', channel: 'local' });
  assert.deepEqual(first, [
    {
      protocol: 'mpgd.notifications.v2',
      sequence: 0,
      event: { type: 'opened', channel: 'remote', source: 'cold', route: '/' },
    },
    {
      protocol: 'mpgd.notifications.v2',
      sequence: 1,
      event: { type: 'received', channel: 'local' },
    },
  ]);
  assert.deepEqual(second, [first[1]]);
  // Another handler is another session, numbered from 0 again.
  const other: BridgeNotificationsEvent[] = [];
  createNotificationsV2BridgeHandler({ provider }).subscribe((envelope) => other.push(envelope));
  assert.equal(other[0]?.sequence, 0);
}

// The backend methods: the session comes from the host, never the payload.
{
  interface TestSession {
    readonly id: string;
    readonly player: string;
    readonly installation: string;
  }
  let current: TestSession | undefined = { id: 'devvit:t2_a', player: 't2_a', installation: 'i-a' };
  const calls: string[] = [];
  const failures: unknown[] = [];
  const record = {
    kind: 'topic-preference',
    topic: 'daily',
    state: 'granted',
    source: 'player',
    at: '2026-10-21T00:00:00Z',
  } as const;
  const notice = {
    kind: 'consent-result',
    record: { kind: 'advertising', state: 'granted', at: '2026-10-21T00:00:00Z', textVersion: '1' },
    dueBy: '2026-11-20',
    variant: 'consent-result.advertising.granted',
  } as const;
  let failWith: unknown;
  const served = async <Value>(name: string, session: TestSession, value: Value): Promise<Value> => {
    calls.push(`${name}:${session.player}:${session.installation}`);
    if (failWith !== undefined) {
      throw failWith;
    }
    return value;
  };
  const backend: NotificationsBackendBridgeServer<TestSession> = {
    session: () => current,
    recordConsent: (session) => served('recordConsent', session, record),
    listConsent: (session) => served('listConsent', session, [record]),
    registerEndpoint: (session) => served('registerEndpoint', session, undefined),
    unregisterEndpoint: (session) => served('unregisterEndpoint', session, undefined),
    setReminder: (session) => served('setReminder', session, 'scheduled' as const),
    cancelReminder: (session) => served('cancelReminder', session, true),
    listNotices: (session) => served('listNotices', session, [notice]),
    recordNotice: (session) => served('recordNotice', session, undefined),
  };
  const handler = createNotificationsBackendBridgeHandler({
    backend,
    label: 'Test',
    unexpectedFailureMessage: (method) => `${method} failed on the test host.`,
    onError: (error) => failures.push(error),
  });
  const ok = async (method: string, payload: unknown): Promise<unknown> => {
    const response = await handler.request(request(method, payload));
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.ok ? response.data : undefined;
  };
  const player = { expectedPlayer: 't2_a' };

  assert.deepEqual(await ok('notifications.backend.getSession', protocol), {
    session: { id: 'devvit:t2_a', player: 't2_a' },
  });
  assert.deepEqual(await ok('notifications.backend.recordConsent', { ...player, record }), {
    record,
  });
  assert.deepEqual(await ok('notifications.backend.listConsent', player), { records: [record] });
  assert.deepEqual(await ok('notifications.backend.registerEndpoint', {
    ...player,
    registration: { provider: 'devvit', address: { kind: 'platform-user' }, timeZone: 'Asia/Seoul' },
  }), { registered: true });
  assert.deepEqual(
    await ok('notifications.backend.unregisterEndpoint', { ...player, provider: 'devvit' }),
    {
      unregistered: true,
    },
  );
  assert.deepEqual(await ok('notifications.backend.setReminder', {
    ...player,
    reminder: { key: 'daily', topic: 'daily', fireAt: '2026-10-22T00:00:00Z', link: 't3_post' },
  }), { status: 'scheduled' });
  assert.deepEqual(await ok('notifications.backend.cancelReminder', { ...player, key: 'daily' }), {
    cancelled: true,
  });
  assert.deepEqual(await ok('notifications.backend.listNotices', player), { notices: [notice] });
  assert.deepEqual(await ok('notifications.backend.recordNotice', {
    ...player,
    notice: { kind: notice.kind, record: { kind: 'advertising', at: notice.record.at }, dueBy: notice.dueBy },
    channel: 'in-game',
  }), { recorded: true });
  // Every call acted for the host's session, with the host's installation.
  assert.ok(
    calls.every((call) => call.endsWith(':t2_a:i-a')),
    JSON.stringify(calls),
  );
  assert.equal(calls.length, 8);

  // Another player signed in since the call began: refused before the backend.
  calls.length = 0;
  current = { id: 'devvit:t2_b', player: 't2_b', installation: 'i-b' };
  const changed = errorOf(
    await handler.request(request('notifications.backend.listConsent', player)),
  );
  assert.equal(changed.code, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
  assert.equal(changed.retryable, true);
  assert.equal(
    readBridgeNotificationsHostCode(changed.message),
    notificationsBackendBridgeHostCodes.sessionChanged,
  );
  // Naming the other player in the payload never acts for it: the host's player decides.
  const named = errorOf(
    await handler.request(request('notifications.backend.listConsent', { expectedPlayer: 't2_c' })),
  );
  assert.equal(
    readBridgeNotificationsHostCode(named.message),
    notificationsBackendBridgeHostCodes.sessionChanged,
  );
  assert.deepEqual(calls, []);

  // Signed out: the session read answers null, every call is refused.
  current = undefined;
  assert.deepEqual(await ok('notifications.backend.getSession', protocol), { session: null });
  const signedOut = errorOf(await handler.request(request('notifications.backend.setReminder', {
    ...player,
    reminder: { key: 'daily', topic: 'daily', fireAt: '2026-10-22T00:00:00Z' },
  })));
  assert.equal(signedOut.code, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
  assert.equal(
    readBridgeNotificationsHostCode(signedOut.message),
    notificationsBackendBridgeHostCodes.signedOut,
  );
  assert.deepEqual(calls, []);
  // Expected refusals are not reported.
  assert.deepEqual(failures, []);

  // An invalid payload is the caller's: refused, not reported.
  current = { id: 'devvit:t2_a', player: 't2_a', installation: 'i-a' };
  const invalid = errorOf(await handler.request(request('notifications.backend.recordConsent', {
    ...player,
    record: { ...record, state: 'maybe' },
  })));
  assert.equal(invalid.code, 'NOTIFICATIONS_INVALID_INPUT');
  assert.deepEqual(failures, []);
  assert.deepEqual(calls, []);

  // A backend failure keeps its notifications code; anything else keeps its text on the host.
  failWith = new NotificationError('NOTIFICATIONS_INVALID_INPUT', { message: 'fireAt is too far ahead.' });
  const refused = errorOf(
    await handler.request(request('notifications.backend.cancelReminder', { ...player, key: 'k' })),
  );
  assert.equal(refused.code, 'NOTIFICATIONS_INVALID_INPUT');
  assert.equal(refused.message, 'fireAt is too far ahead.');
  failWith = new Error('redis said something internal');
  const unexpected = errorOf(
    await handler.request(request('notifications.backend.listNotices', player)),
  );
  assert.equal(unexpected.code, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
  assert.equal(unexpected.retryable, true);
  assert.equal(unexpected.message, 'notifications.backend.listNotices failed on the test host.');
  assert.equal(failures.length, 2);
  failWith = undefined;

  // An answer outside the contract is the backend's configuration.
  const brokenFailures: unknown[] = [];
  const broken = createNotificationsBackendBridgeHandler({
    backend: { ...backend, setReminder: async () => 'sent' as never },
    onError: (error) => brokenFailures.push(error),
  });
  const brokenAnswer = errorOf(await broken.request(request('notifications.backend.setReminder', {
    ...player,
    reminder: { key: 'daily', topic: 'daily', fireAt: '2026-10-22T00:00:00Z' },
  })));
  assert.equal(brokenAnswer.code, 'NOTIFICATIONS_CONFIGURATION_REQUIRED');
  assert.equal(brokenAnswer.retryable, false);
  assert.equal(
    brokenAnswer.message,
    'The notifications backend answered notifications.backend.setReminder outside the contract.',
  );
  // The validator's text reaches the host's log through the cause, not the game.
  assert.equal(brokenFailures.length, 1);
  assert.match(String(((brokenFailures[0] as Error).cause as Error).message), /status/u);
  // A failure shaped as a platform failure with another code keeps its flag, not its text.
  failWith = new PlatformOperationError({ code: 'STORAGE_FAILED', message: 'redis host 10.0.0.1 refused', retryable: false });
  const platformFailure = errorOf(
    await handler.request(request('notifications.backend.listNotices', player)),
  );
  assert.equal(platformFailure.code, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
  assert.equal(platformFailure.retryable, false);
  assert.equal(
    platformFailure.message,
    'notifications.backend.listNotices failed on the test host.',
  );
  failWith = undefined;
  // Without a message of its own the handler still keeps the text on the host.
  const plain = createNotificationsBackendBridgeHandler({
    backend: {
      ...backend,
      listConsent: async () => {
        throw new Error('internal detail');
      },
    },
  });
  const plainFailure = errorOf(
    await plain.request(request('notifications.backend.listConsent', player)),
  );
  assert.equal(plainFailure.message, 'notifications.backend.listConsent failed on the host.');
  // A session read that throws is a host failure, not a signed-out answer.
  const throwing = createNotificationsBackendBridgeHandler({
    backend: {
      ...backend,
      session: () => {
        throw new Error('context unavailable');
      },
    },
  });
  const throwingRead = errorOf(
    await throwing.request(request('notifications.backend.getSession', protocol)),
  );
  assert.equal(throwingRead.code, 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE');
  assert.equal(throwingRead.message, 'notifications.backend.getSession failed on the host.');
  assert.equal(
    errorOf(await handler.request(request('notifications.backend.getSession', {}))).code,
    'NOTIFICATIONS_INVALID_INPUT',
  );
  // A provider method is not a backend method.
  assert.equal(
    errorOf(await handler.request(request('notifications.v2.getPermission', { topics: ['a'] }))).code,
    'UNSUPPORTED_METHOD',
  );
}

console.log('notifications v2 and backend bridge handler tests passed');
