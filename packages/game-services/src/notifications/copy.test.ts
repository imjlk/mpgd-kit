import assert from 'node:assert/strict';

import {
  notificationNoticeVariants,
  referenceNotificationProviders,
  type NotificationDeliveryProviderEntry,
  type NotificationDeployment,
  type NotificationNoticeCopy,
  type NotificationTopicDeclaration,
} from '@mpgd/platform/notifications';

import {
  resolveCatalogNotificationCopy,
  resolveNotificationCopy,
  resolveNotificationCopyByLocale,
  type NotificationCopyResolver,
  type NotificationCopyResolverInput,
} from './copy.js';
import type {
  NotificationRemoteDeliveryProvider,
  NotificationRemoteDeliveryRequest,
} from './delivery-provider.js';
import { createNotificationProviderRegistry } from './registry.js';
import { createNotificationService, type NotificationSession } from './service.js';
import { createInMemoryNotificationStore } from './store.js';

/**
 * LC1's server-side copy (RFC "Remote copy", open question 4): the default
 * resolver's locale fallback, a project resolver that replaces it, missing
 * copy that skips the send, the Korean advertising rules over resolved copy,
 * and the reminder, notice, and direct send paths through the resolver.
 */

const copy = {
  ko: { title: '도전', body: '{{name}}님이 도전했어요.' },
  en: { title: 'Challenge', body: '{{name}} challenged you.' },
  'pt-BR': { title: 'Desafio', body: '{{name}} desafiou você.' },
};
const challenge: NotificationTopicDeclaration = {
  id: 'friend-challenge',
  purpose: 'service',
  channels: ['remote'],
  route: '/?entry=challenge',
  copy,
};
const events: NotificationTopicDeclaration = {
  id: 'events',
  purpose: 'advertising',
  channels: ['remote'],
  route: '/events',
  optOutRoute: '/settings/notifications',
  copy: { ko: { title: '주말 이벤트', body: '주말 이벤트가 시작됐어요.' } },
};
const noticeTopic: NotificationTopicDeclaration = {
  id: 'consent-notice',
  purpose: 'service',
  channels: ['remote'],
  route: '/settings/notifications',
};
const noticeCopy: NotificationNoticeCopy = {
  ko: Object.fromEntries(notificationNoticeVariants.map((variant) => [
    variant,
    { title: `[Game] ${variant}`, body: `{{consentDate}} ${variant}` },
  ])) as unknown as NotificationNoticeCopy[string],
};
const kr: NotificationDeployment = {
  advertisingRules: 'kr',
  advertisingSender: { contact: '080-000-0000' },
};
const templateEntry: NotificationDeliveryProviderEntry = {
  ...referenceNotificationProviders['apps-in-toss'],
  provider: 'template',
};

function fakeProvider(id: string) {
  const calls: NotificationRemoteDeliveryRequest[] = [];
  const provider: NotificationRemoteDeliveryProvider & { readonly calls: typeof calls } = {
    id,
    calls,
    async send(request) {
      calls.push(request);
      return { status: 'accepted' };
    },
  };
  return provider;
}

const session = (player: string): NotificationSession => ({
  player,
  sessionId: `s-${player}`,
  installationId: `install-${player}`,
});

function harness(options: {
  readonly topics?: readonly NotificationTopicDeclaration[];
  readonly resolveCopy?: NotificationCopyResolver;
  readonly deployment?: NotificationDeployment;
  readonly notices?: boolean;
  readonly start?: string;
  readonly template?: boolean;
} = {}) {
  let at = Date.parse(options.start ?? '2026-10-19T03:00:00Z');
  const fcm = fakeProvider('fcm');
  const template = fakeProvider('template');
  const store = createInMemoryNotificationStore();
  const errors: string[] = [];
  const topics = options.topics ?? [challenge];
  const service = createNotificationService({
    store,
    registry: createNotificationProviderRegistry([
      { entry: referenceNotificationProviders.fcm, delivery: fcm, targets: ['ios'] },
      ...(options.template === true ? [{ entry: templateEntry, delivery: template, targets: ['ait'] }] : []),
    ]),
    catalog: {
      defaultLocale: 'ko',
      ...(options.notices === true ? { notices: { topic: noticeTopic.id, copy: noticeCopy } } : {}),
      topicsFor: (target) =>
        target === 'ait'
          ? topics.map((topic) => ({
              ...topic,
              mapping: { templateSetCode: `t-${topic.id}`, agreement: 'none' },
            }))
          : topics,
    },
    ...(options.deployment === undefined ? {} : { deployment: options.deployment }),
    ...(options.resolveCopy === undefined ? {} : { resolveCopy: options.resolveCopy }),
    resolvePlatformRecipient: ({ player }) => `user-${player}`,
    now: () => new Date(at).toISOString(),
    random: () => 0,
    onError: (_error, context) => errors.push(context.operation),
  });
  const register = (player: string, locale?: string) =>
    service.registerEndpoint(session(player), {
      registration: {
        provider: 'fcm',
        address: { kind: 'fcm-token', value: `tok-${player}`, permission: 'granted' },
        ...(locale === undefined ? {} : { locale }),
        timeZone: 'Asia/Seoul',
      },
      target: 'ios',
    });
  return {
    service,
    store,
    fcm,
    template,
    errors,
    register,
    set(instant: string) {
      at = Date.parse(instant);
    },
  };
}

/** A resolver that records what it is asked and answers from `answer`. */
function recording(answer: (input: NotificationCopyResolverInput) => ReturnType<NotificationCopyResolver>) {
  const asked: NotificationCopyResolverInput[] = [];
  const resolver: NotificationCopyResolver = (input) => {
    asked.push(input);
    return answer(input);
  };
  return { resolver, asked };
}

// The default resolver: the exact locale, then its language, then the catalog default, ignoring case.
{
  const ask = (locale: string | undefined) =>
    resolveCatalogNotificationCopy({
      topic: challenge,
      provider: 'fcm',
      ...(locale === undefined ? {} : { locale }),
      defaultLocale: 'ko',
    });
  assert.equal((await ask('pt-BR'))?.title, 'Desafio', 'exact');
  assert.equal((await ask('pt-br'))?.title, 'Desafio', 'exact, any case');
  assert.equal((await ask('en-US'))?.title, 'Challenge', 'language');
  assert.equal((await ask('fr-FR'))?.title, '도전', 'catalog default');
  assert.equal((await ask(undefined))?.title, '도전', 'no locale');
  assert.equal(
    await resolveCatalogNotificationCopy({ topic: noticeTopic, provider: 'fcm', locale: 'en', defaultLocale: 'ko' }),
    undefined,
    'a topic without copy has none',
  );

  // Through the service: the recipient's registered locale, unless the send names one.
  const h = harness();
  await h.register('p-en', 'en-US');
  await h.register('p-ko', 'ko-KR');
  await h.register('p-none');
  for (const player of ['p-en', 'p-ko', 'p-none']) {
    await h.service.deliver({
      idempotencyKey: `s-${player}`,
      player,
      topic: challenge.id,
      templateData: { name: 'Mina' },
    });
  }
  await h.service.deliver({
    idempotencyKey: 's-p-en-pt',
    player: 'p-en',
    topic: challenge.id,
    locale: 'pt-BR',
    templateData: { name: 'Mina' },
  });
  assert.deepEqual(
    h.fcm.calls.map((call) => [call.player, call.locale ?? null, call.content.body]),
    [
      ['p-en', 'en-US', 'Mina challenged you.'],
      ['p-ko', 'ko-KR', 'Mina님이 도전했어요.'],
      ['p-none', null, 'Mina님이 도전했어요.'],
      ['p-en', 'pt-BR', 'Mina desafiou você.'],
    ],
  );
}

// A project resolver replaces the default and is asked with the send's context.
{
  const { resolver, asked } = recording((input) =>
    input.locale?.startsWith('ja') === true
      ? { title: '挑戦', body: '{{name}}さんから挑戦状。' }
      : { title: 'Custom', body: 'Custom {{name}}' },
  );
  const h = harness({ resolveCopy: resolver });
  await h.register('p-ja', 'ja-JP');
  await h.register('p-ko', 'ko-KR');
  for (const player of ['p-ja', 'p-ko']) {
    assert.deepEqual(
      await h.service.deliver({ idempotencyKey: `s-${player}`, player, topic: challenge.id, templateData: { name: 'Mina' } }),
      { status: 'delivered', alreadyProcessed: false },
    );
  }
  assert.deepEqual(
    h.fcm.calls.map((call) => [call.content.title, call.content.body]),
    [
      ['挑戦', 'Minaさんから挑戦状。'],
      // The catalog has ko copy, but the project's resolver answers instead.
      ['Custom', 'Custom Mina'],
    ],
  );
  assert.deepEqual(asked[0], {
    topic: challenge,
    provider: 'fcm',
    locale: 'ja-JP',
    defaultLocale: 'ko',
    templateData: { name: 'Mina' },
  });
  // A resolver that falls back to the catalog for what it does not cover.
  const fallback = harness({
    resolveCopy: (input) =>
      input.locale === 'ja-JP'
        ? { title: '挑戦', body: '挑戦状' }
        : resolveCatalogNotificationCopy(input),
  });
  await fallback.register('p-en', 'en-GB');
  await fallback.service.deliver({
    idempotencyKey: 'k',
    player: 'p-en',
    topic: challenge.id,
    templateData: { name: 'Jun' },
  });
  assert.equal(fallback.fcm.calls[0]?.content.body, 'Jun challenged you.');
}

// Missing copy skips the send with a clear outcome; nothing is sent or stored.
{
  const h = harness({ resolveCopy: () => undefined });
  await h.register('p-1', 'en');
  assert.deepEqual(
    await h.service.deliver({ idempotencyKey: 'missing', player: 'p-1', topic: challenge.id, templateData: { name: 'A' } }),
    { status: 'unavailable', reason: 'copy-missing' },
  );
  assert.equal(h.fcm.calls.length, 0);
  assert.deepEqual(h.store.inspect().sends, []);
  // An answer that cannot be sent is no copy, and the operator hears why.
  for (const answer of [{ title: ' ', body: 'B' }, { title: 'T' }, 'text', 7]) {
    const bad = harness({ resolveCopy: () => answer as never });
    await bad.register('p-1');
    assert.deepEqual(
      await bad.service.deliver({ idempotencyKey: 'bad', player: 'p-1', topic: challenge.id }),
      { status: 'unavailable', reason: 'copy-missing' },
      JSON.stringify(answer),
    );
    assert.equal(bad.fcm.calls.length, 0);
    assert.deepEqual(bad.errors, ['copy.resolve']);
  }
  // A send or reminder never carries its own text.
  await assert.rejects(
    h.service.deliver({
      idempotencyKey: 'own',
      player: 'p-1',
      topic: challenge.id,
      title: 'T',
      body: 'B',
    }),
    { code: 'NOTIFICATIONS_INVALID_INPUT' },
  );
  await assert.rejects(
    h.service.setReminder(session('p-1'), {
      key: 'r',
      topic: challenge.id,
      fireAt: '2026-10-19T04:00:00Z',
      body: 'B',
    }),
    { code: 'NOTIFICATIONS_INVALID_INPUT' },
  );
}

// A resolver that throws is a host that cannot answer: the send is retried, not skipped.
{
  const h = harness({
    resolveCopy: () => {
      throw new Error('copy store down');
    },
  });
  await h.register('p-1');
  await assert.rejects(
    h.service.deliver({
      idempotencyKey: 'down',
      player: 'p-1',
      topic: challenge.id,
      templateData: { name: 'A' },
    }),
    { code: 'NOTIFICATIONS_TEMPORARILY_UNAVAILABLE' },
  );
  assert.equal(h.fcm.calls.length, 0);
}

// Advertising: resolved copy is labelled, signed, and carries the opt-out line and action under the Korean rules.
{
  const { resolver } = recording(() => ({ title: 'Weekend event', body: 'It starts now.' }));
  const h = harness({ topics: [events], deployment: kr, resolveCopy: resolver });
  await h.register('p-1', 'en');
  await h.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  assert.deepEqual(
    await h.service.deliver({ idempotencyKey: 'ad', player: 'p-1', topic: events.id }),
    { status: 'delivered', alreadyProcessed: false },
  );
  const content = h.fcm.calls[0]?.content;
  assert.equal(content?.title, '(광고) Weekend event');
  assert.equal(content?.body, '(광고) 080-000-0000\nIt starts now.\n무료 수신거부: 수신거부 버튼');
  assert.deepEqual(content?.actions, [
    { id: 'advertising-opt-out', title: '수신거부', route: '/settings/notifications' },
  ]);
  assert.ok(h.fcm.calls[0]?.expiresAt !== undefined, 'without night consent it expires at 21:00');
  // A resolver that already wrote the label gets it once.
  const labelled = harness({
    topics: [events],
    deployment: kr,
    resolveCopy: () => ({ title: '(광고) Sale', body: 'Now.' }),
  });
  await labelled.register('p-1');
  await labelled.service.recordConsent(session('p-1'), {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  });
  await labelled.service.deliver({ idempotencyKey: 'ad', player: 'p-1', topic: events.id });
  assert.equal(labelled.fcm.calls[0]?.content.title, '(광고) Sale');
  // Advertising consent is still checked first, and a refused recipient costs no resolver call.
  const refused = recording(() => ({ title: 'Weekend event', body: 'It starts now.' }));
  const unconsented = harness({ topics: [events], deployment: kr, resolveCopy: refused.resolver });
  await unconsented.register('p-1');
  assert.deepEqual(
    await unconsented.service.deliver({ idempotencyKey: 'ad', player: 'p-1', topic: events.id }),
    { status: 'suppressed', reason: 'advertising-consent-missing' },
  );
  assert.equal(refused.asked.length, 0);
}

// Server reminders fire through the resolver with the recipient's locale; missing copy spends no send.
{
  const { resolver, asked } = recording((input) =>
    input.locale === 'en' ? { title: 'Your turn', body: '{{name}} is waiting.' } : undefined,
  );
  const h = harness({ resolveCopy: resolver });
  await h.register('p-en', 'en');
  await h.register('p-fr', 'fr');
  for (const player of ['p-en', 'p-fr']) {
    assert.deepEqual(
      await h.service.setReminder(session(player), {
        key: 'rematch',
        topic: challenge.id,
        fireAt: '2026-10-19T04:00:00Z',
        templateData: { name: 'Jun' },
      }),
      { status: 'scheduled' },
    );
  }
  h.set('2026-10-19T04:00:00Z');
  const run = await h.service.runScheduler();
  assert.deepEqual(
    run.results.map((result) => [result.sendKey.split(':')[1], result.outcome]),
    [
      ['p-en', { status: 'delivered', alreadyProcessed: false }],
      ['p-fr', { status: 'unavailable', reason: 'copy-missing' }],
    ],
  );
  assert.deepEqual(
    h.fcm.calls.map((call) => [call.player, call.content.body]),
    [['p-en', 'Jun is waiting.']],
  );
  assert.ok(asked.some((input) => input.locale === 'en' && input.templateData?.['name'] === 'Jun'));
}

// Consent notices go through the resolver with their variant, and its text must keep the notice rules.
{
  const consent = {
    kind: 'advertising',
    state: 'granted',
    source: 'player',
    textVersion: 'v1',
  } as const;
  const { resolver, asked } = recording((input) =>
    input.notice !== undefined && input.locale === 'en'
      ? { title: '[Game] Consent result', body: 'On {{consentDate}} you agreed to advertising.' }
      : resolveCatalogNotificationCopy(input),
  );
  const h = harness({
    topics: [events, noticeTopic],
    deployment: kr,
    notices: true,
    resolveCopy: resolver,
  });
  await h.register('p-en', 'en');
  await h.register('p-ko', 'ko');
  await h.service.recordConsent(session('p-en'), consent);
  await h.service.recordConsent(session('p-ko'), consent);
  h.set('2026-10-25T15:00:00Z');
  await h.service.runScheduler();
  assert.deepEqual(
    h.fcm.calls.map((call) => [call.player, call.content.title, call.content.body]),
    [
      ['p-en', '[Game] Consent result', 'On 2026-10-19 you agreed to advertising.'],
      [
        'p-ko',
        '[Game] consent-result.advertising.granted',
        '2026-10-19 consent-result.advertising.granted',
      ],
    ],
  );
  const noticeAsk = asked.find((input) => input.notice !== undefined);
  assert.deepEqual(noticeAsk?.notice, { variant: 'consent-result.advertising.granted' });
  assert.equal(noticeAsk?.topic.id, 'consent-notice');
  // A notice text without the date breaks the notice rules: no push, the operator hears why, and the check backs off.
  const undated = harness({
    topics: [events, noticeTopic],
    deployment: kr,
    notices: true,
    resolveCopy: (input) =>
      input.notice === undefined
        ? resolveCatalogNotificationCopy(input)
        : { title: '[Game] Result', body: 'Done.' },
  });
  await undated.register('p-1');
  await undated.service.recordConsent(session('p-1'), consent);
  undated.set('2026-10-25T15:00:00Z');
  await undated.service.runScheduler();
  assert.equal(undated.fcm.calls.length, 0);
  assert.ok(undated.errors.includes('copy.resolve'));
  assert.equal(
    undated.store.inspect().schedule.find((entry) => entry.id === 'notices')?.item.kind,
    'notices',
    'the notice is still owed',
  );
}

// Mapping text and host templates never reach the resolver.
{
  const { resolver, asked } = recording(() => undefined);
  const mapped = harness({
    topics: [{ ...challenge, mapping: { title: 'Mapped', body: 'Text' } }],
    resolveCopy: resolver,
  });
  await mapped.register('p-1');
  assert.deepEqual(
    await mapped.service.deliver({ idempotencyKey: 'm', player: 'p-1', topic: challenge.id }),
    { status: 'delivered', alreadyProcessed: false },
  );
  assert.equal(mapped.fcm.calls[0]?.content.title, 'Mapped');
  const template = harness({ resolveCopy: resolver, template: true });
  assert.deepEqual(
    await template.service.deliver({ idempotencyKey: 't', player: 'p-1', topic: challenge.id, provider: 'template' }),
    { status: 'delivered', alreadyProcessed: false },
  );
  assert.deepEqual(template.template.calls[0]?.content, {
    route: '/?entry=challenge',
    source: 'host-template',
  });
  assert.equal(asked.length, 0);
}

// Bulk sends resolve once per locale group.
{
  const { resolver, asked } = recording((input) =>
    input.locale === undefined ? undefined : { title: input.locale, body: 'B' },
  );
  const groups = await resolveNotificationCopyByLocale(resolver, {
    topic: challenge,
    provider: 'fcm',
    defaultLocale: 'ko',
    locales: ['en', 'ko', 'en', undefined, 'ko'],
  });
  assert.deepEqual(
    asked.map((input) => input.locale ?? null),
    ['en', 'ko', null],
  );
  assert.deepEqual(
    [...groups],
    [
      ['en', { copy: { title: 'en', body: 'B' } }],
      ['ko', { copy: { title: 'ko', body: 'B' } }],
      [undefined, {}],
    ],
  );
  assert.deepEqual(
    await resolveNotificationCopy(() => ({ title: 'T', body: 'B', extra: 1 }) as never, {
      topic: challenge,
      provider: 'fcm',
      defaultLocale: 'ko',
    }),
    { copy: { title: 'T', body: 'B' } },
    'only the title and body are kept',
  );
}

console.info('Notifications copy tests passed.');
