import assert from 'node:assert/strict';

import { referenceNotificationProviders } from '@mpgd/platform/notifications';

import {
  defaultNotificationDeploymentFile,
  defaultNotificationTopicsFile,
  NotificationTopicsValidationError,
  readNotificationDeploymentFile,
  referenceNotificationTargetRegistry,
  selectNotificationDeploymentFile,
  selectNotificationTopicsFile,
  validateNotificationTopicsFile,
} from './validate-notification-topics';

// `pnpm validate:notifications [file] [deployment]` reads the first argument,
// then MPGD_NOTIFICATION_TOPICS_FILE, then the default path, which a game may
// not have: the kit ships no starter catalog until the starter topic purposes
// are decided (RFC open question 1).
assert.deepEqual(selectNotificationTopicsFile(['catalog.json'], {}), {
  path: 'catalog.json',
  explicit: true,
});
assert.deepEqual(
  selectNotificationTopicsFile([], { MPGD_NOTIFICATION_TOPICS_FILE: ' env.json ' }),
  { path: 'env.json', explicit: true },
);
assert.deepEqual(
  selectNotificationTopicsFile(['arg.json'], { MPGD_NOTIFICATION_TOPICS_FILE: 'env.json' }),
  { path: 'arg.json', explicit: true },
);
assert.deepEqual(selectNotificationTopicsFile([], { MPGD_NOTIFICATION_TOPICS_FILE: '  ' }), {
  path: defaultNotificationTopicsFile,
  explicit: false,
});
// The deployment settings come from the second argument, then
// MPGD_NOTIFICATION_DEPLOYMENT_FILE, then the default path.
assert.deepEqual(selectNotificationDeploymentFile(['catalog.json', 'deployment.json'], {}), {
  path: 'deployment.json',
  explicit: true,
});
assert.deepEqual(
  selectNotificationDeploymentFile(['catalog.json'], {
    MPGD_NOTIFICATION_DEPLOYMENT_FILE: 'env.json',
  }),
  { path: 'env.json', explicit: true },
);
assert.deepEqual(selectNotificationDeploymentFile([], {}), {
  path: defaultNotificationDeploymentFile,
  explicit: false,
});

// Reference targets enable the reference providers.
const registry = referenceNotificationTargetRegistry();
assert.equal(registry.android, referenceNotificationProviders.fcm);
assert.equal(registry.ios, referenceNotificationProviders.fcm);
assert.equal(registry.ait, referenceNotificationProviders['apps-in-toss']);
assert.equal(registry.reddit, referenceNotificationProviders.devvit);
assert.deepEqual(Object.keys(registry).sort(), ['ait', 'android', 'ios', 'reddit']);

// The fixtures: the valid catalog passes with its deployment settings, the
// invalid one lists every issue.
const fixtures = 'packages/catalog/test/fixtures/notification-topics';
const deployment = readNotificationDeploymentFile(`${fixtures}/deployment.json`);
assert.equal(deployment.advertisingRules, 'kr');
const valid = validateNotificationTopicsFile(`${fixtures}/valid.json`, registry, deployment);
assert.deepEqual(
  valid.topics.map((topic) => topic.id),
  ['energy-full', 'rival-challenge', 'purchase-result', 'consent-notice', 'weekend-event'],
);
// The advertising topic needs the deployment settings.
assert.throws(
  () => validateNotificationTopicsFile(`${fixtures}/valid.json`),
  (error: unknown) =>
    error instanceof NotificationTopicsValidationError
    && error.issues.map((issue) => issue.path).join() === 'deployment.advertisingRules',
);
assert.throws(
  () => readNotificationDeploymentFile(`${fixtures}/valid.json`),
  /advertisingRules|topics|version|defaultLocale|notices/u,
);
assert.throws(
  () => validateNotificationTopicsFile(`${fixtures}/invalid.json`),
  (error: unknown) => {
    assert.ok(error instanceof NotificationTopicsValidationError);
    assert.equal(error.path, `${fixtures}/invalid.json`);
    // Every RFC rule the fixture breaks, reported at once.
    assert.deepEqual(
      error.issues.map((issue) => `${issue.path}: ${issue.message}`),
      [
        'topics[0].route: "https://example.com/?entry=continue" must be a root-relative path '
          + "on the game's origin, such as /?entry=continue",
        'topics[0].copy: copy must include the default locale ko',
        'topics[0].targets.ait.templateSetCode: apps-in-toss needs templateSetCode',
        "topics[0].targets.ait.agreement: only a service topic's template may need no agreement; "
          + 'energy-full is requested',
        'topics[0].targets.reddit.title: devvit accepts at most 60 characters in title; got 65',
        'topics[0].targets.reddit.link: devvit needs link to match ^t[13]_[A-Za-z0-9]+$; '
          + 'got "https://reddit.com/r/game"',
        'topics[1].optOutRoute: advertising topics need an optOutRoute, the screen where the '
          + 'player withdraws advertising consent',
        'topics[1].targets.ait: apps-in-toss does not deliver advertising as free-form content; '
          + 'an advertising topic must not map to it',
        'topics[2].id: duplicates the id of topics[0]: energy-full',
        "topics[3].copy: the notice topic's text is notices.copy, one per notice variant; "
          + 'consent-notice declares no copy of its own',
        'notices.copy: must include the default locale ko',
        'notices.copy["en"]["consent-result.night.withdrawn"]: every locale needs a title and a '
          + 'body for each notice variant; en lacks consent-result.night.withdrawn',
        'notices.copy["en"]["consent-result.advertising.granted"].body: notices are filled only '
          + 'with {{consentDate}}; {{playerName}} would have no value',
        'notices.copy["en"]["consent-result.advertising.withdrawn"].body: a brace outside a '
          + '{{name}} placeholder reaches the player as written; write {{consentDate}}',
        'notices.copy["en"]["consent-result.advertising.withdrawn"]: a notice states the date of '
          + 'the act it reports on; its title or body needs {{consentDate}}',
        'notices.copy["en"]["reconfirmation.night"].body: a notice\'s body must not be blank',
        'notices.copy["en"]["reconfirmation.night"]: a notice states the date of the act it '
          + 'reports on; its title or body needs {{consentDate}}',
        "deployment.advertisingRules: a catalog with an advertising topic needs the deployment's "
          + "advertisingRules: 'kr' or 'none'",
      ],
    );
    assert.match(
      error.message,
      /invalid\.json is not a valid notification topic catalog:\n- topics\[0\]\.route/u,
    );
    return true;
  },
);
// Without provider entries no provider's mapping rules apply. The catalog's
// own rules still do, such as no title or body in the notice topic's mapping,
// and this fixture breaks none of those in a mapping.
assert.throws(
  () => validateNotificationTopicsFile(`${fixtures}/invalid.json`, {}),
  (error: unknown) =>
    error instanceof NotificationTopicsValidationError
    && error.issues.every((issue) => !issue.path.includes('.targets.')),
);

console.info('validate:notifications tool test passed.');
