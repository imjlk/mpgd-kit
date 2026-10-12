import {
  referenceNotificationProviders,
  type NotificationDeployment,
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
const krDeployment: NotificationDeployment = {
  advertisingRules: 'kr',
  advertisingSender: { contact: '080-1234-5678' },
  noticeTopic: 'consent-notice',
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

// A catalog that exercises every field passes against the reference providers.
const valid = assertNotificationTopicCatalog(
  {
    version: '2026-10-12',
    defaultLocale: 'ko',
    notices: { topic: 'consent-notice' },
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
          'storefront-web': { channel: 'open targets stay unchecked' },
        },
      },
      {
        id: 'consent-notice',
        purpose: 'service',
        channels: ['remote'],
        route: '/settings/notifications',
        copy: { ko: { title: '수신 동의 안내', body: '{{consentDate}}에 동의하셨어요.' } },
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
        targets: { android: { channelId: 'advertising' }, ios: {} },
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
for (const route of [
  '/%2F%2Fevil.example/x',
  '/%5Cevil.example',
  '/%09/evil.example',
  '/levels/%252e%252e',
  '/50%',
]) {
  assert.equal(isRootRelativeNotificationRoute(route), false, `${route} is refused once decoded`);
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
assert.deepEqual(issuesOf(catalogWith({ ...advertising, targets: { android: {} } })), []);

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

// Open target names without a provider entry stay unchecked.
assert.deepEqual(
  issuesOf(catalogWith({ ...advertising, targets: { 'storefront-web': { anything: true } } })),
  [],
);
// Without provider entries only the catalog-wide rules apply.
assert.equal(
  validateNotificationTopicCatalog(catalogWith({ ...baseTopic, targets: { ait: {} } })).valid,
  true,
);

// The notice topic is a declared service topic the server can send.
const noticeTopic = {
  id: 'consent-notice',
  purpose: 'service',
  channels: ['remote'],
  route: '/settings/notifications',
  copy: { ko: { title: '안내', body: '{{consentDate}}' } },
  targets: { android: { channelId: 'notices' } },
} as const satisfies NotificationTopicCatalogEntry;
const withNotices = (topic: string, ...topics: readonly unknown[]): unknown => ({
  version: 'test',
  defaultLocale: 'ko',
  notices: { topic },
  topics,
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
// The server fills a notice only with the consent date.
assertIssue(
  withNotices('consent-notice', {
    ...noticeTopic,
    copy: { ko: { title: '{{playerName}}님', body: '{{ consentDate }}' } },
  }),
  'topics[0].copy.ko.title',
  /filled only with \{\{consentDate\}\}; \{\{playerName\}\} would have no value/u,
  'a notice placeholder other than consentDate',
);
assertIssue(
  withNotices('consent-notice', {
    ...noticeTopic,
    targets: { reddit: { title: 'Notice', body: 'Agreed on {{date}}' } },
  }),
  'topics[0].targets.reddit.body',
  /\{\{date\}\} would have no value/u,
  'a mapped notice text is filled the same way',
);

// An advertising topic needs the deployment's rules, and under the Korean
// rules the sender and the notice topic; a provider without an expiry or the
// opt-out action cannot carry it then.
const advertisingTopic = { ...advertising, targets: { android: {} } };
const advertisingCatalog = catalogWith(advertisingTopic, noticeTopic);
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
  ['notices.topic', 'deployment.noticeTopic', 'deployment.advertisingSender'],
);
assert.deepEqual(
  issuesOf(withNotices('consent-notice', advertisingTopic, noticeTopic), krDeployment),
  [],
);
assertIssue(
  withNotices('consent-notice', advertisingTopic, noticeTopic),
  'deployment.noticeTopic',
  /must be the catalog's notices.topic \(consent-notice\)/u,
  'the deployment names the catalog notice topic',
  { ...krDeployment, noticeTopic: 'other' },
);
// The scheduler sends overdue notices only through the deployment's
// noticeTopic, so under the Korean rules an advertising catalog needs it.
const { noticeTopic: _noticeTopic, ...krWithoutNoticeTopic } = krDeployment;
assert.deepEqual(
  issuesOf(withNotices('consent-notice', advertisingTopic, noticeTopic), krWithoutNoticeTopic),
  [
    'deployment.noticeTopic: the Korean advertising rules send overdue consent notices only '
      + "through the deployment's noticeTopic; set it to the catalog's notices.topic (consent-notice)",
  ],
);
// Without an advertising topic, or under 'none', no notice topic is needed.
assert.deepEqual(issuesOf(catalogWith(baseTopic), krWithoutNoticeTopic), []);
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
    validateNotificationTopicCatalog(withNotices('consent-notice', advertisingTopic, noticeTopic), {
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
  validateNotificationTopicCatalog(withNotices('consent-notice', advertisingTopic, noticeTopic), {
    targetProviders: { android: noExpiry },
    deployment: krDeployment,
  }).issues.some((issue) =>
    issue.path === 'topics[0].targets.android' && /expiry and the opt-out action/u.test(issue.message)),
  'a provider without an expiry cannot carry advertising under the Korean rules',
);
// Under the Korean rules, a target that delivers advertising also delivers its notices.
assertIssue(
  withNotices('consent-notice', { ...advertising, targets: { android: {}, ios: {} } }, noticeTopic),
  'notices.topic',
  /consent-notice has no mapping for ios, which delivers an advertising topic/u,
  'the notice topic is mapped where advertising is',
  krDeployment,
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
