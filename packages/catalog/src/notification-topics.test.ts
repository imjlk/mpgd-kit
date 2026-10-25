import {
  notificationNoticeVariants,
  referenceNotificationProviders,
  type NotificationDeployment,
  type NotificationNoticeCopy,
  type NotificationNoticeVariant,
  type NotificationProviderRegistryEntry,
} from '@mpgd/platform/notifications';

import {
  assertNotificationTopicCatalog,
  isRootRelativeNotificationRoute,
  resolveNotificationTopicsForTarget,
  validateNotificationTopicCatalog,
  type NotificationTopicCatalog,
  type NotificationTopicCatalogEntry,
} from './index.js';

// The catalog package type-checks without Node types, so this test keeps its
// own assertions; the file-level fixtures run in tools/validate-notification-topics.test.ts.
const assert = {
  ok(value: unknown, message: string): void {
    if (value !== true) {
      throw new Error(message);
    }
  },
  equal(actual: unknown, expected: unknown, message = 'values differ'): void {
    if (actual !== expected) {
      throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message = 'values differ'): void {
    if (!sameValue(actual, expected)) {
      throw new Error(
        `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      );
    }
  },
  throws(callback: () => unknown, pattern: RegExp, message: string): void {
    try {
      callback();
    } catch (error) {
      assert.ok(pattern.test(error instanceof Error ? error.message : String(error)), message);
      return;
    }
    throw new Error(`${message}: nothing was thrown`);
  },
};

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]));
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return sameValue(leftKeys, rightKeys)
      && leftKeys.every((key) =>
        sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return Object.is(left, right);
}

const targetProviders: Readonly<Record<string, NotificationProviderRegistryEntry>> = {
  android: referenceNotificationProviders.fcm,
  ios: referenceNotificationProviders.fcm,
  ait: referenceNotificationProviders['apps-in-toss'],
  reddit: referenceNotificationProviders.devvit,
};

const baseTopic = {
  id: 'energy-full',
  purpose: 'requested',
  channels: ['local', 'remote'],
  route: '/?entry=continue',
  copy: { ko: { title: '에너지 충전 완료', body: '에너지가 가득 찼어요.' } },
} as const satisfies NotificationTopicCatalogEntry;

function catalogWith(...topics: readonly unknown[]): unknown {
  return { version: 'test', defaultLocale: 'ko', topics };
}

/** Deployment settings without the Korean rules, so the rules below are checked on their own. */
const plainDeployment: NotificationDeployment = { advertisingRules: 'none' };
// Pure catalog APIs must work on mini-game runtimes with no DOM URL global.
{
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'URL');
  Object.defineProperty(globalThis, 'URL', { configurable: true, value: undefined });
  try {
    const options = { targetProviders, deployment: plainDeployment };
    assert.ok(
      validateNotificationTopicCatalog(catalogWith(baseTopic), options).valid,
      'valid catalog without URL',
    );
    assertNotificationTopicCatalog(catalogWith(baseTopic), options);
    assert.ok(
      !validateNotificationTopicCatalog(catalogWith({ ...baseTopic, route: '/.//evil.example' }), options).valid,
      'unsafe catalog without URL',
    );
    assert.throws(
      () => assertNotificationTopicCatalog(catalogWith({ ...baseTopic, route: '/é' }), options),
      /normalized form/u,
      'invalid catalog without URL reports a validation error',
    );
  } finally {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'URL');
    } else {
      Object.defineProperty(globalThis, 'URL', descriptor);
    }
  }
}
const krDeployment: NotificationDeployment = {
  advertisingRules: 'kr',
  advertisingSender: { contact: '080-1234-5678' },
};

function issuesOf(input: unknown, deployment: NotificationDeployment = plainDeployment): readonly string[] {
  const result = validateNotificationTopicCatalog(input, { targetProviders, deployment });
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`);
}

function assertIssue(
  input: unknown,
  path: string,
  pattern: RegExp,
  message: string,
  deployment: NotificationDeployment = plainDeployment,
): void {
  const result = validateNotificationTopicCatalog(input, { targetProviders, deployment });
  assert.equal(result.valid, false, message);
  assert.ok(
    result.issues.some((issue) => issue.path === path && pattern.test(issue.message)),
    `${message}: expected an issue at ${path} matching ${String(pattern)}, got ${JSON.stringify(result.issues)}`,
  );
}

/** The catalog's notice copy: a title and a body for each notice variant. */
const koNotices = Object.fromEntries(
  notificationNoticeVariants.map((variant) => [
    variant,
    { title: '수신 동의 안내', body: `{{consentDate}} ${variant}` },
  ]),
) as Readonly<Record<NotificationNoticeVariant, { readonly title: string; readonly body: string }>>;
const noticeCopy: NotificationNoticeCopy = { ko: koNotices };

// A catalog that exercises every field passes against the reference providers.
const valid = assertNotificationTopicCatalog(
  {
    version: '2026-10-12',
    defaultLocale: 'ko',
    notices: { topic: 'consent-notice', copy: noticeCopy },
    topics: [
      {
        ...baseTopic,
        copy: { ...baseTopic.copy, en: { title: 'Energy full', body: 'Your energy is full.' } },
        frequency: { maxPerDay: 3 },
        quietHours: { start: '22:00', end: '08:00' },
        targets: {
          ait: { templateSetCode: 'fixture-energy-full', agreement: 'required' },
          android: { channelId: 'reminders' },
          ios: {},
          reddit: { title: 'Energy full', body: 'Your energy is full again.', link: 't3_energy' },
        },
      },
      {
        id: 'rival-challenge',
        purpose: 'service',
        channels: ['remote'],
        route: '/?entry=challenge',
        copy: { ko: { title: '새 도전장', body: '{{rival}}님이 도전장을 보냈어요.' } },
        targets: {
          ait: { templateSetCode: 'fixture-rival-challenge', agreement: 'none' },
          'storefront-web': { channel: 'an open target follows no provider rules' },
        },
      },
      {
        id: 'consent-notice',
        purpose: 'service',
        channels: ['remote'],
        route: '/settings/notifications',
        targets: { android: { channelId: 'notices' }, ios: {} },
      },
      {
        id: 'weekend-event',
        purpose: 'advertising',
        channels: ['remote'],
        route: '/events/weekend',
        optOutRoute: '/settings/notifications',
        deferrable: false,
        copy: { ko: { title: '주말 이벤트', body: '주말 이벤트가 시작됐어요.' } },
        targets: { ios: {} },
      },
    ],
  },
  { targetProviders, deployment: krDeployment },
);
assert.equal(valid.topics.length, 4);
assert.throws(
  () => assertNotificationTopicCatalog(catalogWith({ ...baseTopic, route: 'continue' })),
  /Invalid notification topic catalog:\n- topics\[0\]\.route/u,
  'assertNotificationTopicCatalog lists every issue',
);

// Routes are root-relative and pass the deep-link policy.
for (const route of [
  '/',
  '/?entry=continue',
  '/events/weekend',
  '/events/weekend/',
  '/a/b?c=d#e',
  '/?next=..',
  '/?next=//evil.example',
  '/levels/%2e1',
  '/a%20b',
]) {
  assert.equal(isRootRelativeNotificationRoute(route), true, `${route} is root-relative`);
}
// A client that decodes the path before routing would open these on another host.
for (const route of ['/%2F%2Fevil.example/x', '/%5Cevil.example', '/%09/evil.example']) {
  assert.equal(isRootRelativeNotificationRoute(route), false, `${route} is refused once decoded`);
}
// A route is declared in the form a player opens: anything else names its normalized form.
for (const [route, normalized] of [
  ['/é', '/%C3%A9'],
  ['/a b', '/a%20b'],
  ['/a/../b', '/b'],
] as const) {
  assert.equal(isRootRelativeNotificationRoute(route), false, `${route} is not in normalized form`);
  const { issues } = validateNotificationTopicCatalog(catalogWith({ ...baseTopic, route }), {
    targetProviders,
    deployment: plainDeployment,
  });
  assert.ok(
    issues.some((issue) => issue.path === 'topics[0].route'
      && issue.message.endsWith(`must be written in its normalized form, ${JSON.stringify(normalized)}`)),
    `${route} names its normalized form: ${JSON.stringify(issues)}`,
  );
}
// Each of these passes a same-origin check against a placeholder base, yet a
// URL parser resolves it to a protocol-relative path such as //evil.example/x.
const protocolRelativeOnceResolved = [
  '/.//evil.example/x',
  '/levels/..//evil.example/x',
  '/%2e//evil.example/x',
  '/./\\evil.example/x',
];
for (const route of [
  '',
  'events/weekend',
  'https://example.com/',
  '//evil.example/path',
  '/\\evil.example',
  '/a/../b',
  '/./a',
  '/a/..',
  '/%2E/a',
  '/a/%2e%2E/b',
  '/a/.%2e',
  '/a/%2e.',
  ' /padded',
  '/line\nbreak',
  '/\t/evil.example',
  `/${'a'.repeat(2048)}`,
  ...protocolRelativeOnceResolved,
]) {
  assert.equal(
    isRootRelativeNotificationRoute(route),
    false,
    `${JSON.stringify(route)} is refused`,
  );
}
assertIssue(
  catalogWith({ ...baseTopic, route: '//evil.example' }),
  'topics[0].route',
  /root-relative/u,
  'a protocol-relative route is refused',
);
for (const route of protocolRelativeOnceResolved) {
  assertIssue(
    catalogWith({ ...baseTopic, route }),
    'topics[0].route',
    /root-relative/u,
    `${route} is refused as a route`,
  );
  assertIssue(
    catalogWith({ ...baseTopic, purpose: 'advertising', optOutRoute: route }),
    'topics[0].optOutRoute',
    /root-relative/u,
    `${route} is refused as an opt-out route`,
  );
}
assertIssue(
  catalogWith({ ...baseTopic, purpose: 'advertising', optOutRoute: 'settings' }),
  'topics[0].optOutRoute',
  /root-relative/u,
  'the opt-out route is root-relative too',
);

// An advertising topic needs an opt-out route; other purposes do not.
assertIssue(
  catalogWith({ ...baseTopic, purpose: 'advertising' }),
  'topics[0].optOutRoute',
  /need an optOutRoute/u,
  'advertising needs optOutRoute',
);
assert.deepEqual(issuesOf(catalogWith({ ...baseTopic, purpose: 'service' })), []);

// Every copy includes the default locale; a topic without copy is allowed.
assertIssue(
  catalogWith({
    ...baseTopic,
    copy: { en: { title: 'Energy full', body: 'Your energy is full.' } },
  }),
  'topics[0].copy',
  /default locale ko/u,
  'copy without the default locale is refused',
);
const { copy: _copy, ...withoutCopy } = baseTopic;
assert.deepEqual(issuesOf(catalogWith(withoutCopy)), []);
// The default locale matches a copy key without regard to case, as every
// locale match does; a language alone is not the default locale.
const usCopy = { title: 'Energy full', body: 'Your energy is full.' };
assert.deepEqual(
  issuesOf({
    version: 'test',
    defaultLocale: 'en-US',
    topics: [{ ...baseTopic, copy: { 'en-us': usCopy } }],
  }),
  [],
);
assertIssue(
  { version: 'test', defaultLocale: 'en-US', topics: [{ ...baseTopic, copy: { en: usCopy } }] },
  'topics[0].copy',
  /default locale en-US/u,
  'a copy with only the language of the default locale is refused',
);

// Apps in Toss mappings need a non-empty templateSetCode and the agreement the template states.
assertIssue(
  catalogWith({ ...baseTopic, targets: { ait: {} } }),
  'topics[0].targets.ait.templateSetCode',
  /needs templateSetCode/u,
  'an Apps in Toss mapping needs templateSetCode',
);
assertIssue(
  catalogWith({ ...baseTopic, targets: { ait: { templateSetCode: 'energy' } } }),
  'topics[0].targets.ait.agreement',
  /needs agreement/u,
  'an Apps in Toss mapping needs agreement',
);
assertIssue(
  catalogWith({
    ...baseTopic,
    targets: { ait: { templateSetCode: 'energy', agreement: 'optional' } },
  }),
  'topics[0].targets.ait.agreement',
  /accepts agreement "required" or "none"; got "optional"/u,
  'agreement is required or none',
);
// Only a service template may skip the agreement.
assertIssue(
  catalogWith({ ...baseTopic, targets: { ait: { templateSetCode: 'energy', agreement: 'none' } } }),
  'topics[0].targets.ait.agreement',
  /only a service topic's template may need no agreement/u,
  'a requested topic needs an agreement',
);
assert.deepEqual(
  issuesOf(
    catalogWith({
      ...baseTopic,
      purpose: 'service',
      targets: { ait: { templateSetCode: 'receipt', agreement: 'none' } },
    }),
  ),
  [],
);
assertIssue(
  catalogWith({ ...baseTopic, targets: { ait: { templateSetCode: '  ', agreement: 'required' } } }),
  'topics[0].targets.ait.templateSetCode',
  /non-empty templateSetCode/u,
  'a blank templateSetCode is refused',
);
assertIssue(
  catalogWith({ ...baseTopic, targets: { ait: { templateSetCode: 42, agreement: 'required' } } }),
  'topics[0].targets.ait.templateSetCode',
  /as a string/u,
  'a numeric templateSetCode is refused',
);

// Devvit mappings need title <= 60 and body <= 100 characters (code points).
assert.deepEqual(
  issuesOf(
    catalogWith({
      ...baseTopic,
      targets: { reddit: { title: 'é'.repeat(60), body: '🎮'.repeat(100) } },
    }),
  ),
  [],
);
assertIssue(
  catalogWith({ ...baseTopic, targets: { reddit: { title: 'x'.repeat(61), body: 'ok' } } }),
  'topics[0].targets.reddit.title',
  /at most 60 characters/u,
  'a 61-character Devvit title is refused',
);
assertIssue(
  catalogWith({ ...baseTopic, targets: { reddit: { title: 'ok', body: 'x'.repeat(101) } } }),
  'topics[0].targets.reddit.body',
  /at most 100 characters/u,
  'a 101-character Devvit body is refused',
);
assertIssue(
  catalogWith({ ...baseTopic, targets: { reddit: { title: 'ok' } } }),
  'topics[0].targets.reddit.body',
  /needs body/u,
  'a Devvit mapping needs both title and body',
);
// A default Devvit link names a post or a comment.
for (const link of ['t3_abc123', 't1_Z9']) {
  assert.deepEqual(
    issuesOf(catalogWith({ ...baseTopic, targets: { reddit: { title: 'ok', body: 'ok', link } } })),
    [],
  );
}
for (const link of ['t2_abc', 'https://reddit.com/r/x', 't3_']) {
  assertIssue(
    catalogWith({ ...baseTopic, targets: { reddit: { title: 'ok', body: 'ok', link } } }),
    'topics[0].targets.reddit.link',
    /needs link to match/u,
    `${link} is not a post or comment id`,
  );
}

// An advertising topic is remote only, and maps only to a provider that
// delivers advertising as free-form content.
const advertising = {
  ...baseTopic,
  purpose: 'advertising',
  channels: ['remote'],
  optOutRoute: '/settings/notifications',
};
assertIssue(
  catalogWith({ ...advertising, channels: ['local', 'remote'] }),
  'topics[0].channels',
  /may not use the local channel/u,
  'advertising cannot be scheduled on the device',
);
assertIssue(
  catalogWith({ ...advertising, targets: { reddit: { title: 'Sale', body: 'A sale started.' } } }),
  'topics[0].targets.reddit',
  /does not deliver advertising as free-form content/u,
  'advertising cannot map to Devvit',
);
const advertisingTemplates: NotificationProviderRegistryEntry = {
  ...referenceNotificationProviders['apps-in-toss'],
  provider: 'fixture.host-template-ads',
  purposes: ['service', 'requested', 'advertising'],
};
assert.equal(
  validateNotificationTopicCatalog(
    catalogWith({ ...advertising, targets: { kiosk: { templateSetCode: 'sale', agreement: 'required' } } }),
    { targetProviders: { kiosk: advertisingTemplates }, deployment: plainDeployment },
  ).issues.some((issue) => issue.path === 'topics[0].targets.kiosk'),
  true,
  'a host-template provider cannot carry the advertising label even if it lists the purpose',
);
// An Android FCM notification message cannot carry the opt-out action, so an
// advertising topic maps to android only when the deployment says the shell
// renders advertising itself; whatever the rules, without it the mapping is refused.
const androidRefusal = 'topics[0].targets.android: an advertising topic maps to android only when '
  + 'the shell renders it with the opt-out action, which an FCM notification message on android '
  + "cannot carry; wire the kit's advertising renderer into the shell and set shellRendersAdvertising "
  + 'in the deployment';
assert.deepEqual(issuesOf(catalogWith({ ...advertising, targets: { android: {} } })), [
  androidRefusal,
]);
assert.deepEqual(
  issuesOf(catalogWith({ ...advertising, targets: { android: {} } }), {
    ...plainDeployment,
    shellRendersAdvertising: false,
  }),
  [androidRefusal],
);
assert.deepEqual(
  issuesOf(catalogWith({ ...advertising, targets: { android: {} } }), {
    ...plainDeployment,
    shellRendersAdvertising: true,
  }),
  [],
  'a shell that renders advertising allows the android mapping',
);
// An open target is not one whose pushes need the shell: no provider rules apply to it.
assert.deepEqual(issuesOf(catalogWith({ ...advertising, targets: { ios: {} } })), []);

// Any topic with the remote channel maps only to a provider whose purposes
// include its purpose, or gate step 1 refuses every send (`purpose-unsupported`).
const withPurposes = (purposes: NotificationProviderRegistryEntry['purposes']): NotificationProviderRegistryEntry => ({
  ...referenceNotificationProviders.fcm,
  provider: `fixture.${purposes.join('-')}`,
  purposes,
});
const kioskIssues = (topic: unknown, provider: NotificationProviderRegistryEntry) =>
  validateNotificationTopicCatalog(catalogWith(topic), {
    targetProviders: { kiosk: provider },
    deployment: plainDeployment,
  }).issues.map((issue) => `${issue.path}: ${issue.message}`);
assert.deepEqual(kioskIssues({ ...baseTopic, targets: { kiosk: {} } }, withPurposes(['service'])), [
  'topics[0].targets.kiosk: fixture.service does not deliver requested topics; '
    + 'a requested topic with the remote channel must not map to it',
]);
assert.deepEqual(
  kioskIssues({ ...baseTopic, purpose: 'service', targets: { kiosk: {} } }, withPurposes(['requested'])),
  [
    'topics[0].targets.kiosk: fixture.requested does not deliver service topics; '
      + 'a service topic with the remote channel must not map to it',
  ],
);
assert.deepEqual(
  kioskIssues({ ...baseTopic, targets: { kiosk: {} } }, withPurposes(['service', 'requested'])),
  [],
);
// A local-only topic is never sent remotely, so remote purposes do not apply to it.
assert.deepEqual(
  kioskIssues(
    { ...baseTopic, channels: ['local'], targets: { kiosk: {} } },
    withPurposes(['service']),
  ),
  [],
);

// A registry pattern is read with the u flag: one that does not compile there
// is an issue, not a SyntaxError.
const loosePattern: NotificationProviderRegistryEntry = {
  ...referenceNotificationProviders.devvit,
  provider: 'fixture.loose-pattern',
  mapping: {
    ...referenceNotificationProviders.devvit.mapping,
    link: { required: false, pattern: '^t[13]_[\\w-.]+$' },
  },
};
assert.deepEqual(
  kioskIssues(
    { ...baseTopic, targets: { kiosk: { title: 'Energy', body: 'Full.', link: 't3_energy' } } },
    loosePattern,
  ),
  [
    "topics[0].targets.kiosk.link: fixture.loose-pattern's pattern for link does not compile "
      + 'with the u flag: ^t[13]_[\\w-.]+$',
  ],
);

// A topic that needs no agreement never prompts, so a per-send provider would
// never get the acceptance each send needs.
const perSendTemplates: NotificationProviderRegistryEntry = {
  ...referenceNotificationProviders['apps-in-toss'],
  provider: 'fixture.per-send',
  permission: {
    ...referenceNotificationProviders['apps-in-toss'].permission,
    allowance: 'per-send',
  },
};
const serviceTemplate = { ...baseTopic, purpose: 'service', channels: ['remote'] };
assert.deepEqual(
  kioskIssues(
    { ...serviceTemplate, targets: { kiosk: { templateSetCode: 'refund', agreement: 'none' } } },
    perSendTemplates,
  ),
  [
    "topics[0].targets.kiosk.agreement: fixture.per-send needs the player's acceptance for each "
      + 'send, which a topic that needs no agreement never asks for',
  ],
);
assert.deepEqual(
  kioskIssues(
    { ...serviceTemplate, targets: { kiosk: { templateSetCode: 'refund', agreement: 'required' } } },
    perSendTemplates,
  ),
  [],
);

// An open target name, without a provider entry, follows no provider's mapping rules.
assert.deepEqual(
  issuesOf(catalogWith({ ...advertising, targets: { 'storefront-web': { anything: true } } })),
  [],
);
// Without provider entries only the catalog-wide rules apply.
assert.equal(
  validateNotificationTopicCatalog(catalogWith({ ...baseTopic, targets: { ait: {} } })).valid,
  true,
);

// The notice topic is a declared service topic the server can send. It keeps
// only the delivery settings: no copy of its own, which the free-form rule
// does not ask for either, because a notice's text is notices.copy.
const noticeTopic = {
  id: 'consent-notice',
  purpose: 'service',
  channels: ['remote'],
  route: '/settings/notifications',
  targets: { android: { channelId: 'notices' } },
} as const satisfies NotificationTopicCatalogEntry;
const withNotices = (topic: string, ...topics: readonly unknown[]): unknown => ({
  version: 'test',
  defaultLocale: 'ko',
  notices: { topic, copy: noticeCopy },
  topics,
});
const withNoticeCopy = (copy: unknown): unknown => ({
  version: 'test',
  defaultLocale: 'ko',
  notices: copy === undefined ? { topic: 'consent-notice' } : { topic: 'consent-notice', copy },
  topics: [noticeTopic],
});
assert.deepEqual(issuesOf(withNotices('consent-notice', noticeTopic)), []);
assertIssue(
  withNotices('missing', noticeTopic),
  'notices.topic',
  /names no declared topic/u,
  'an unknown notice topic',
);
assertIssue(
  withNotices('consent-notice', { ...noticeTopic, purpose: 'requested' }),
  'notices.topic',
  /must be a service topic with the remote channel/u,
  'a notice topic is a service topic',
);
assertIssue(
  withNotices('consent-notice', { ...noticeTopic, channels: ['local'] }),
  'notices.topic',
  /must be a service topic with the remote channel/u,
  'the server sends a notice remotely',
);
// A notice says what the player did, in notices.copy: the notice topic's own
// copy, a title or body in its mapping, or a host template would replace it.
assertIssue(
  withNotices('consent-notice', {
    ...noticeTopic,
    copy: { ko: { title: '안내', body: '{{consentDate}}' } },
  }),
  'topics[0].copy',
  /the notice topic's text is notices\.copy, one per notice variant; consent-notice declares no copy/u,
  'a notice topic with its own copy',
);
assertIssue(
  withNotices('consent-notice', {
    ...noticeTopic,
    targets: { android: { channelId: 'notices', title: 'Notice', body: 'You agreed.' } },
  }),
  'topics[0].targets.android.body',
  /its mappings carry no title or body, not even one alone; remove body/u,
  'a notice topic mapping with its own text',
);
// A lone title is refused too, on a provider target or an open one.
for (const target of ['android', 'storefront-web']) {
  assert.deepEqual(
    issuesOf(withNotices('consent-notice', {
      ...noticeTopic,
      targets: { [target]: { channelId: 'notices', title: 'Notice' } },
    })),
    [
      `topics[0].targets.${target}.title: the notice topic's text is notices.copy, so its `
        + 'mappings carry no title or body, not even one alone; remove title',
    ],
    `a lone title in the notice topic's ${target} mapping`,
  );
}
assertIssue(
  withNotices('consent-notice', {
    ...noticeTopic,
    targets: { ait: { templateSetCode: 'notice', agreement: 'none' } },
  }),
  'topics[0].targets.ait',
  /apps-in-toss sends its own template, which cannot state what the player did/u,
  'a notice topic on a host-template provider',
);
// A provider whose mapping carries its own approved text is reported once,
// whether or not the mapping gives it.
for (const reddit of [{}, { title: 'Notice', body: 'You agreed.' }]) {
  assert.deepEqual(
    issuesOf(withNotices('consent-notice', { ...noticeTopic, targets: { reddit } })),
    [
      'topics[0].targets.reddit: devvit sends the text of its mapping, which cannot state what '
        + 'the player did; the notice topic must not map to it',
    ],
    'a notice topic on a provider with mapped text',
  );
}
// Only the server sends a notice.
assertIssue(
  withNotices('consent-notice', { ...noticeTopic, channels: ['local', 'remote'] }),
  'topics[0].channels',
  /only the server sends consent notices; the notice topic declares no local channel/u,
  'a notice topic with the local channel',
);
// notices.copy gives every locale, the default one included, a title and a
// body for each variant, filled only with the consent date.
assertIssue(
  withNoticeCopy(undefined),
  'notices.copy',
  /give a title and a body for each notice variant in each locale/u,
  'notices without copy',
);
assertIssue(
  withNoticeCopy({ en: koNotices }),
  'notices.copy',
  /must include the default locale ko/u,
  'notice copy without the default locale',
);
assert.deepEqual(
  issuesOf(withNoticeCopy({ KO: koNotices })),
  [],
  'the locale matches without regard to case',
);
const { 'reconfirmation.night': _night, ...withoutNight } = koNotices;
assertIssue(
  withNoticeCopy({ ko: withoutNight }),
  'notices.copy["ko"]["reconfirmation.night"]',
  /ko lacks reconfirmation\.night/u,
  'a locale without a variant',
);
assertIssue(
  withNoticeCopy({ ko: { ...koNotices, 'reconfirmation.later': { title: '안내', body: '안내' } } }),
  'notices.copy["ko"]["reconfirmation.later"]',
  /is not a notice variant/u,
  'an unknown variant',
);
// A refusal's text is optional: without it, a refusal is given in the
// withdrawal's text. Given, it follows the same rules.
const {
  'consent-result.advertising.refused': _advertisingRefusal,
  'consent-result.night.refused': _nightRefusal,
  ...withoutRefusals
} = koNotices;
assert.deepEqual(issuesOf(withNoticeCopy({ ko: withoutRefusals })), []);
assertIssue(
  withNoticeCopy({
    ko: { ...koNotices, 'consent-result.night.refused': { title: '거부', body: '거부' } },
  }),
  'notices.copy["ko"]["consent-result.night.refused"]',
  /states the date of the act it reports on/u,
  'a refusal text follows the notice rules',
);
for (const [field, text] of [
  ['title', ' '],
  ['body', ''],
] as const) {
  assertIssue(
    withNoticeCopy({
      ko: {
        ...koNotices,
        'consent-result.night.granted': {
          title: '{{consentDate}}',
          body: '{{consentDate}}',
          [field]: text,
        },
      },
    }),
    `notices.copy["ko"]["consent-result.night.granted"].${field}`,
    new RegExp(`a notice's ${field} must not be blank`, 'u'),
    `a blank notice ${field}`,
  );
}
assertIssue(
  withNoticeCopy({
    ko: {
      ...koNotices,
      'consent-result.advertising.withdrawn': {
        title: '{{playerName}}님',
        body: '{{ consentDate }}',
      },
    },
  }),
  'notices.copy["ko"]["consent-result.advertising.withdrawn"].title',
  /filled only with \{\{consentDate\}\}; \{\{playerName\}\} would have no value/u,
  'a notice placeholder other than consentDate',
);
// Each variant states the date of the act it reports on, in its title or its
// body, and a brace outside a {{name}} placeholder would reach the player as
// written.
const nightReconfirmation = (title: string, body: string): unknown =>
  withNoticeCopy({ ko: { ...koNotices, 'reconfirmation.night': { title, body } } });
assert.deepEqual(
  issuesOf(nightReconfirmation('안내', '확인')),
  [
    'notices.copy["ko"]["reconfirmation.night"]: a notice states the date of the act it reports '
      + 'on; its title or body needs {{consentDate}}',
  ],
  'a notice variant without the consent date',
);
assert.deepEqual(issuesOf(nightReconfirmation('{{consentDate}} 확인', '확인')), []);
for (const body of [
  '{consentDate}',
  '{{consentDate}',
  'consentDate}}',
  '{{consent.date}}',
  '｛｛consentDate｝｝',
  '{{consentDate}}}',
]) {
  assertIssue(
    nightReconfirmation('{{consentDate}} 확인', body),
    'notices.copy["ko"]["reconfirmation.night"].body',
    /a brace outside a \{\{name\}\} placeholder reaches the player as written/u,
    `a stray brace in ${body}`,
  );
}
// Locale and variant keys are spelled in brackets, whatever they hold.
assert.deepEqual(
  issuesOf({
    version: 'test',
    defaultLocale: 'ko-KR',
    notices: {
      topic: 'consent-notice',
      copy: {
        'ko-KR': { ...koNotices, 'reconfirmation.night': { title: 1, body: '{{consentDate}}' } },
      },
    },
    topics: [noticeTopic],
  }),
  ['notices.copy["ko-KR"]["reconfirmation.night"].title: expected a string title'],
);
// A value left undefined is an issue, never an exception.
assert.deepEqual(issuesOf(withNoticeCopy({ ko: undefined })), [
  'notices.copy["ko"]: expected the notice copy of one locale: a title and a body per notice variant',
]);
assert.deepEqual(
  issuesOf(withNoticeCopy({ ko: { ...koNotices, 'reconfirmation.night': undefined } })),
  [
    'notices.copy["ko"]["reconfirmation.night"]: every locale needs a title and a body for each '
      + 'notice variant; ko lacks reconfirmation.night',
  ],
);
// So is an undefined topic copy entry, which a send would find before the
// language or the default locale.
assert.deepEqual(
  issuesOf(catalogWith({ ...baseTopic, copy: { ...baseTopic.copy, en: undefined } })),
  ['topics[0].copy["en"]: expected NotificationTopicCopy, a title and a body'],
);
for (const target of ['android', 'storefront-web']) {
  assert.deepEqual(
    issuesOf(withNotices('consent-notice', { ...noticeTopic, targets: { [target]: undefined } })),
    [
      `topics[0].targets.${target}: expected NotificationTopicMapping, an object: {} maps a target `
        + 'that needs no fields',
    ],
    `an undefined ${target} mapping`,
  );
}
// Shape issues name the public types, and never call notices.copy optional.
for (const [notices, issue] of [
  ['consent-notice', 'notices: expected (NotificationTopicCatalogNotices | undefined)'],
  [{ copy: noticeCopy }, 'notices.topic: expected (string & MinLength<1>)'],
  [
    { topic: 'consent-notice', copy: [] },
    'notices.copy: expected NotificationNoticeCopy: each locale mapped to a title and a body per '
      + 'notice variant',
  ],
  [
    { topic: 'consent-notice', copy: { ko: { ...koNotices, 'reconfirmation.night': 'x' } } },
    'notices.copy["ko"]["reconfirmation.night"]: expected NotificationTopicCopy: a title and a body',
  ],
  [
    {
      topic: 'consent-notice',
      copy: { ko: { ...koNotices, 'reconfirmation.night': { title: 'a', body: '{{consentDate}}', x: 1 } } },
    },
    'notices.copy["ko"]["reconfirmation.night"].x: is not part of a notice\'s text; a notice has '
      + 'only a title and a body',
  ],
] as const) {
  assert.deepEqual(
    issuesOf({ version: 'test', defaultLocale: 'ko', notices, topics: [noticeTopic] }),
    [issue],
    `the issue of notices ${JSON.stringify(notices).slice(0, 40)}`,
  );
}
assert.deepEqual(issuesOf(catalogWith({ ...baseTopic, copy: { ko: { title: 1, body: 'b' } } })), [
  'topics[0].copy["ko"].title: expected (string & MinLength<1>)',
]);

// An advertising topic needs the deployment's rules, and under the Korean
// rules the sender and the notice topic; a provider without an expiry or the
// opt-out action cannot carry it then.
const advertisingTopic = { ...advertising, targets: { ios: {} } };
const advertisingNotice = { ...noticeTopic, targets: { ios: {} } };
const advertisingCatalog = catalogWith(advertisingTopic);
assert.deepEqual(
  validateNotificationTopicCatalog(advertisingCatalog, { targetProviders }).issues.map(
    (issue) => issue.path,
  ),
  ['deployment.advertisingRules'],
);
assert.deepEqual(
  validateNotificationTopicCatalog(advertisingCatalog, {
    targetProviders,
    deployment: { advertisingRules: 'kr' },
  }).issues.map((issue) => issue.path),
  ['notices.topic', 'deployment.advertisingSender'],
);
// The catalog's notices block is the one notice setting: the deployment names
// no notice topic.
assert.deepEqual(
  issuesOf(withNotices('consent-notice', advertisingTopic, advertisingNotice), krDeployment),
  [],
);
// Without an advertising topic, or under 'none', no notice topic is needed.
assert.deepEqual(issuesOf(catalogWith(baseTopic), krDeployment), []);
assert.deepEqual(issuesOf(catalogWith(advertisingTopic), { advertisingRules: 'none' }), []);
// The validator reads the sender and the opt-out line as gate step 8 does: a
// blank contact suppresses every advertising send, and a blank name or opt-out
// line is left out of the message.
for (const [deployment, path] of [
  [{ ...krDeployment, advertisingSender: { contact: ' ' } }, 'deployment.advertisingSender.contact'],
  [
    { ...krDeployment, advertisingSender: { name: '\t', contact: '080-1234-5678' } },
    'deployment.advertisingSender.name',
  ],
  [{ ...krDeployment, advertisingOptOutLine: '  ' }, 'deployment.advertisingOptOutLine'],
] as const) {
  assert.deepEqual(
    validateNotificationTopicCatalog(withNotices('consent-notice', advertisingTopic, advertisingNotice), {
      targetProviders,
      deployment,
    }).issues.map((issue) => issue.path),
    [path],
    `${path} is blank`,
  );
}
// Under 'none' the gate reads neither.
assert.deepEqual(
  issuesOf(catalogWith(advertisingTopic), {
    advertisingRules: 'none',
    advertisingSender: { contact: ' ' },
    advertisingOptOutLine: ' ',
  }),
  [],
);
const noExpiry: NotificationProviderRegistryEntry = {
  ...referenceNotificationProviders.fcm,
  expiry: false,
};
assert.ok(
  validateNotificationTopicCatalog(withNotices(
    'consent-notice',
    { ...advertising, targets: { android: {} } },
    noticeTopic,
  ), {
    targetProviders: { android: noExpiry },
    deployment: krDeployment,
  }).issues.some((issue) =>
    issue.path === 'topics[0].targets.android' && /expiry and the opt-out action/u.test(issue.message)),
  'a provider without an expiry cannot carry advertising under the Korean rules',
);
// Under the Korean rules a shell that renders advertising allows the android
// mapping too, with the notice topic mapped there.
assert.deepEqual(
  validateNotificationTopicCatalog(
    withNotices(
      'consent-notice',
      { ...advertising, targets: { android: { channelId: 'mpgd-advertising' } } },
      noticeTopic,
    ),
    { targetProviders, deployment: { ...krDeployment, shellRendersAdvertising: true } },
  ).issues,
  [],
);
// Under the Korean rules, a target that delivers advertising also delivers its notices.
assertIssue(
  withNotices('consent-notice', { ...advertising, targets: { android: {}, ios: {} } }, noticeTopic),
  'notices.topic',
  /consent-notice has no mapping for ios, which delivers an advertising topic/u,
  'the notice topic is mapped where advertising is',
  krDeployment,
);
// A provider that sends its mapping's own text can carry advertising but not
// the notice topic, so under the Korean rules advertising cannot map to it.
// That is reported once, at the advertising mapping, whether or not the
// notice topic maps there too (which is its own issue).
const approvedText: NotificationProviderRegistryEntry = {
  ...referenceNotificationProviders.fcm,
  provider: 'fixture.approved-text',
  mappingFields: ['title', 'body'],
  mapping: { title: { required: true, maxLength: 60 }, body: { required: true, maxLength: 100 } },
};
const approvedAdvertising = {
  ...advertising,
  targets: { web: { title: '(광고) 주말 이벤트', body: '주말 이벤트가 시작됐어요.' } },
};
const advertisingOnApprovedText = 'topics[0].targets.web: fixture.approved-text sends the text of '
  + 'its mapping, so it cannot carry the consent notices that advertising on web needs under the '
  + 'Korean rules; an advertising topic must not map to it';
for (const [targets, noticeIssues] of [
  [{}, []],
  [
    { web: {} },
    [
      'topics[1].targets.web: fixture.approved-text sends the text of its mapping, which cannot '
        + 'state what the player did; the notice topic must not map to it',
    ],
  ],
] as const) {
  assert.deepEqual(
    validateNotificationTopicCatalog(
      withNotices('consent-notice', approvedAdvertising, { ...noticeTopic, targets }),
      { targetProviders: { web: approvedText }, deployment: krDeployment },
    ).issues.map((issue) => `${issue.path}: ${issue.message}`),
    [advertisingOnApprovedText, ...noticeIssues],
    `the notice topic maps to ${JSON.stringify(targets)}`,
  );
}
// Without the Korean rules the advertising mapping is fine there.
assert.deepEqual(
  validateNotificationTopicCatalog(withNotices('consent-notice', approvedAdvertising, noticeTopic), {
    targetProviders: { web: approvedText },
    deployment: plainDeployment,
  }).issues,
  [],
);
// Without an advertising topic no deployment is needed.
assert.equal(
  validateNotificationTopicCatalog(catalogWith(baseTopic), { targetProviders }).valid,
  true,
);

// A free-form provider sends, and a local notification shows, the topic's own
// text: copy, or a title and a body in the mapping.
assertIssue(
  catalogWith({ ...withoutCopy, targets: { android: { channelId: 'energy' } } }),
  'topics[0].targets.android',
  /declare copy, or a title and a body/u,
  'a remote topic without copy needs mapped text on FCM',
);
assertIssue(
  catalogWith({ ...withoutCopy, channels: ['local'], targets: { android: {} } }),
  'topics[0].targets.android',
  /declare copy, or a title and a body/u,
  'a local-only topic without copy has nothing to show',
);
assert.deepEqual(
  issuesOf(
    catalogWith({
      ...withoutCopy,
      targets: { android: { title: 'Energy full', body: 'Your energy is full.' } },
    }),
  ),
  [],
);
// A host-template provider renders its own text.
assert.deepEqual(
  issuesOf(
    catalogWith({
      ...withoutCopy,
      targets: { ait: { templateSetCode: 'energy-full', agreement: 'required' } },
    }),
  ),
  [],
);

// Ids are unique and trimmed; channels do not repeat; quiet hours have a length.
assertIssue(
  catalogWith(baseTopic, { ...baseTopic, purpose: 'service' }),
  'topics[1].id',
  /duplicates the id of topics\[0\]/u,
  'duplicate ids are refused',
);
assertIssue(
  catalogWith({ ...baseTopic, id: ' energy-full' }),
  'topics[0].id',
  /trimmed/u,
  'untrimmed ids are refused',
);
assertIssue(
  catalogWith({ ...baseTopic, channels: ['local', 'local'] }),
  'topics[0].channels',
  /must not repeat/u,
  'repeated channels are refused',
);
assertIssue(
  catalogWith({ ...baseTopic, quietHours: { start: '22:00', end: '22:00' } }),
  'topics[0].quietHours',
  /same time/u,
  'empty quiet hours are refused',
);

// The shape is strict: unknown keys, bad enums, and malformed values are issues with paths.
for (const [patch, path] of [
  [{ purpose: 'marketing' }, 'topics[0].purpose'],
  [{ channels: [] }, 'topics[0].channels'],
  [{ channels: ['push'] }, 'topics[0].channels[0]'],
  [{ quietHours: { start: '24:00', end: '08:00' } }, 'topics[0].quietHours.start'],
  [{ frequency: { maxPerDay: 0 } }, 'topics[0].frequency.maxPerDay'],
  [{ deferrable: 'no' }, 'topics[0].deferrable'],
  [{ optoutRoute: '/settings' }, 'topics[0].optoutRoute'],
] as const) {
  const result = validateNotificationTopicCatalog(catalogWith({ ...baseTopic, ...patch }));
  assert.equal(result.valid, false, `${JSON.stringify(patch)} is refused`);
  assert.ok(
    result.issues.some((issue) => issue.path === path),
    `${JSON.stringify(patch)} reports ${path}, got ${JSON.stringify(result.issues)}`,
  );
}
assert.equal(validateNotificationTopicCatalog({ version: 'test', topics: [] }).valid, false);
assert.equal(validateNotificationTopicCatalog(null).valid, false);

// The catalog resolves per target: only mapped topics, each with that target's mapping.
const catalog = valid satisfies NotificationTopicCatalog;
const ait = resolveNotificationTopicsForTarget(catalog, 'ait');
assert.deepEqual(
  ait.map((topic) => [topic.id, topic.mapping]),
  [
    ['energy-full', { templateSetCode: 'fixture-energy-full', agreement: 'required' }],
    ['rival-challenge', { templateSetCode: 'fixture-rival-challenge', agreement: 'none' }],
  ],
);
assert.equal(
  ait.some((topic) => 'targets' in topic),
  false,
);
assert.deepEqual(
  resolveNotificationTopicsForTarget(catalog, 'ios').map((topic) => [topic.id, topic.mapping]),
  [
    ['energy-full', {}],
    ['consent-notice', {}],
    ['weekend-event', {}],
  ],
);
assert.deepEqual(resolveNotificationTopicsForTarget(catalog, 'wechat'), []);

console.info('Notification topic catalog validation test passed.');
