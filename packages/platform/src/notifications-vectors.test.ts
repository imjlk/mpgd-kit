import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createUnsupportedNotificationCapabilities,
  notificationNoticeVariants,
  notificationsProtocolVersion,
} from './notifications.js';
import {
  assertNotificationConformanceVector,
  isNotificationConformanceVector,
  notificationConformanceAppliesToReason,
  notificationConformanceVectorNameOf,
  type NotificationConformanceStep,
} from './notifications-vectors.js';

const vectorsDir = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  'specs',
  'notifications',
  'vectors',
);
const vectorFiles = readdirSync(vectorsDir).filter((file) => file.endsWith('.json')).sort();

function readVector(file: string): unknown {
  return JSON.parse(readFileSync(join(vectorsDir, file), 'utf8')) as unknown;
}

describe('notifications conformance vectors', () => {
  it('ships the fifty RFC vectors', () => {
    expect(vectorFiles).toEqual([
      'action-required-login.json',
      'advertising-needs-consent.json',
      'advertising-night-window.json',
      'advertising-notice-variants.json',
      'advertising-notices.json',
      'advertising-rules-none.json',
      'advertising-sender-required.json',
      'advertising-unsupported-by-host.json',
      'endpoint-fan-out.json',
      'endpoint-lifecycle.json',
      'endpoint-rotation.json',
      'endpoint-unbind-on-logout.json',
      'endpoint-unbind-on-session-end.json',
      'game-rendered-opt-in-again.json',
      'game-rendered-opt-in.json',
      'game-rendered-opt-out.json',
      'host-agreement-dismissed.json',
      'host-agreement-recorded.json',
      'host-agreement-rejected.json',
      'host-agreement-then-withdrawn.json',
      'host-gesture-and-terms.json',
      'host-link-required.json',
      'host-service-topic-without-agreement.json',
      'idempotency-key-reuse.json',
      'landing-open-before-listener.json',
      'local-capacity-keeps-nearest.json',
      'local-only-topic.json',
      'local-reminder-cancelled-on-withdrawal.json',
      'local-schedule-never-prompts.json',
      'open-before-listener.json',
      'os-permission-denied-once.json',
      'os-permission-denied-twice.json',
      'os-permission-dismissed.json',
      'os-permission-granted.json',
      'os-permission-revoked-in-settings.json',
      'per-send-allowance.json',
      'provider-ambiguous-replay.json',
      'provider-daily-limit.json',
      'provider-minute-limit.json',
      'provider-rate-limited.json',
      'provider-rejected.json',
      'quiet-hours-player-zone.json',
      'reminder-cancel-across-routes.json',
      'reminder-local-quiet-hours.json',
      'reminder-local-route.json',
      'reminder-server-deferred-cancel.json',
      'reminder-server-route.json',
      'reminder-server-set-checks.json',
      'requested-topic-needs-opt-in.json',
      'unsupported-target.json',
    ]);
  });

  it.each(vectorFiles)('%s validates, matches its file name, and fits its own profile', (file) => {
    const vector = assertNotificationConformanceVector(readVector(file));
    expect(vector.vector).toBe(notificationConformanceVectorNameOf(file));
    expect(vector.protocol).toBe(notificationsProtocolVersion);
    expect(vector.appliesTo.length).toBeGreaterThan(0);
    expect(notificationConformanceAppliesToReason(vector.appliesTo, vector.profile.capabilities))
      .toBeUndefined();
  });

  it('covers every actor and action the RFC names', () => {
    const seen = new Set<string>();
    for (const file of vectorFiles) {
      for (const step of assertNotificationConformanceVector(readVector(file)).steps) {
        seen.add(`${step.actor}.${step.action}`);
      }
    }
    const named: readonly `${NotificationConformanceStep['actor']}.${NotificationConformanceStep['action']}`[] = [
      'runtime.start',
      'runtime.restart',
      'clock.set',
      'host.queuePrompt',
      'host.setPermission',
      'host.issueEndpoint',
      'host.completeAction',
      'host.tap',
      'game.getPermission',
      'game.requestPermission',
      'game.revokePermission',
      'game.register',
      'game.unregister',
      'game.setTopicPreference',
      'game.setAdvertisingConsent',
      'game.setReminder',
      'game.cancelReminder',
      'game.listNotices',
      'game.recordNotice',
      'game.openSettings',
      'game.subscribe',
      'backend.authenticate',
      'backend.deliver',
      'backend.queueProviderResult',
      'backend.registerEndpoint',
      'backend.revokeSession',
      'backend.runScheduler',
    ];
    // `clock.advance` is part of the format; no committed vector uses it.
    // Authentication registers on its own, so only a vector that comes back
    // after the registration went stale uses `game.register`.
    expect([...seen].sort()).toEqual([...named].sort());
  });

  it('rejects malformed vectors', () => {
    const base = assertNotificationConformanceVector(readVector('os-permission-granted.json'));
    expect(isNotificationConformanceVector(base)).toBe(true);
    expect(isNotificationConformanceVector({ ...base, vector: 'OS Permission' })).toBe(false);
    expect(isNotificationConformanceVector({ ...base, steps: [] })).toBe(false);
    expect(isNotificationConformanceVector({
      ...base,
      steps: [...base.steps, { actor: 'host', action: 'revoke' }],
    })).toBe(false);
    expect(isNotificationConformanceVector({
      ...base,
      steps: [...base.steps, { actor: 'clock', action: 'set', at: 'tomorrow' }],
    })).toBe(false);
    expect(isNotificationConformanceVector({
      ...base,
      steps: [...base.steps, { actor: 'host', action: 'queuePrompt', result: 'maybe' }],
    })).toBe(false);
    expect(isNotificationConformanceVector({ ...base, expect: { ...base.expect, sends: [] } })).toBe(false);
    // A step expects an answer or an error, and a provider answer carries only its own fields.
    expect(isNotificationConformanceVector({
      ...base,
      steps: [...base.steps, {
        actor: 'game',
        action: 'openSettings',
        returns: 'opened',
        throws: { code: 'NOTIFICATIONS_UNSUPPORTED' },
      }],
    })).toBe(false);
    for (const [answer, valid] of [
      [{ result: 'rejected', reason: 'agreement' }, true],
      [{ result: 'rejected' }, false],
      [{ result: 'accepted', reason: 'recipient' }, false],
      [{ result: 'rate-limited', retryAfterSeconds: 30 }, true],
      [{ result: 'ambiguous', retryAfterSeconds: 30 }, false],
    ] as const) {
      expect(
        isNotificationConformanceVector({
          ...base,
          steps: [...base.steps, { actor: 'backend', action: 'queueProviderResult', ...answer }],
        }),
        JSON.stringify(answer),
      ).toBe(valid);
    }
    expect(isNotificationConformanceVector({ ...base, catalog: [...base.catalog, ...base.catalog] })).toBe(false);
    // The deployment block takes the RFC settings; a sender needs a contact.
    expect(isNotificationConformanceVector({
      ...base,
      deployment: {
        advertisingRules: 'kr',
        advertisingSender: { name: 'Studio', contact: '080-1234-5678' },
        advertisingOptOutLine: '무료 수신거부: 설정 > 알림',
        timeZone: 'Asia/Seoul',
      },
    })).toBe(true);
    // The notice topic is the `notices` block's, not a deployment setting.
    expect(isNotificationConformanceVector({
      ...base,
      deployment: { advertisingRules: 'kr', noticeTopic: 'consent-notice' },
    })).toBe(false);
    expect(isNotificationConformanceVector({ ...base, deployment: { advertisingSender: { name: 'Studio' } } }))
      .toBe(false);
    expect(isNotificationConformanceVector({ ...base, deployment: { advertisingRules: 'eu' } })).toBe(false);
    // Quiet hours read the zones, so `Intl` must know them.
    expect(isNotificationConformanceVector({ ...base, deployment: { timeZone: 'Mars/Olympus_Mons' } })).toBe(false);
    expect(isNotificationConformanceVector({ ...base, context: { ...base.context, timeZone: 'Mars/Olympus_Mons' } }))
      .toBe(false);
    expect(isNotificationConformanceVector({ ...base, deployment: { sender: {} } })).toBe(false);
    // A catalog topic breaks a topic rule: advertising may not be local.
    const [first] = base.catalog;
    expect(first === undefined ? true : isNotificationConformanceVector({
      ...base,
      catalog: [{ ...first, purpose: 'advertising', optOutRoute: '/settings', channels: ['local', 'remote'] }],
    })).toBe(false);
    expect(isNotificationConformanceVector({
      ...base,
      appliesTo: [{ path: 'permission.prompt', equals: 'host' }],
    })).toBe(false);
    expect(isNotificationConformanceVector({
      ...base,
      appliesTo: [{ path: 'permission.colour', equals: 'os' }],
    })).toBe(false);
    expect(isNotificationConformanceVector({
      ...base,
      appliesTo: [{ path: 'permission prompt', equals: 'os' }],
    })).toBe(false);
  });

  it('reads every timestamp and date in a vector strictly', () => {
    const base = assertNotificationConformanceVector(readVector('reminder-local-route.json'));
    const steps = base.steps.map((step) =>
      step.actor === 'game' && step.action === 'setReminder'
        ? { ...step, input: { ...step.input, fireAt: '2026-04-31T06:00:00Z' } }
        : step);
    expect(() => assertNotificationConformanceVector({ ...base, steps }))
      .toThrow(/steps\[\d+\]\.input\.fireAt must be RFC 3339/u);
    expect(() => assertNotificationConformanceVector({
      ...base,
      expect: { ...base.expect, reminders: [{ fireAt: '2026-10-12 06:00:00Z' }] },
    })).toThrow(/expect\.reminders\[0\]\.fireAt must be RFC 3339/u);
    expect(() => assertNotificationConformanceVector({
      ...base,
      expect: { ...base.expect, notices: [{ dueBy: '2026-02-30' }] },
    })).toThrow(/expect\.notices\[0\]\.dueBy must be a date that exists/u);
  });

  it('runs the OS denial vectors only where the endpoint, not a record, holds the permission', () => {
    for (const name of ['os-permission-denied-once', 'os-permission-denied-twice', 'os-permission-dismissed']) {
      const vector = assertNotificationConformanceVector(readVector(`${name}.json`));
      // An app-scope platform-user provider would write delivery-permission records.
      expect(vector.expect.consent, name).toEqual([]);
      expect(vector.appliesTo, name).toContainEqual({ path: 'remote.addressing', equals: 'device' });
    }
  });

  it('sends advertising before consent under advertisingRules none', () => {
    const vector = assertNotificationConformanceVector(readVector('advertising-rules-none.json'));
    expect(vector.deployment).toEqual({ advertisingRules: 'none' });
    const consent = vector.steps.findIndex((step) => step.action === 'setAdvertisingConsent');
    expect(vector.steps.slice(0, consent).find((step) => step.action === 'deliver')).toMatchObject({
      returns: { status: 'suppressed', reason: 'advertising-consent-missing' },
    });
  });

  it('moves the endpoint in endpoint-lifecycle on authentication alone', () => {
    const vector = assertNotificationConformanceVector(readVector('endpoint-lifecycle.json'));
    const authentications = vector.steps.flatMap((step, index) =>
      step.actor === 'backend' && step.action === 'authenticate' ? [index] : []);
    expect(authentications).toHaveLength(2);
    expect(vector.steps.slice(authentications.at(-1)).some((step) => step.action === 'register'))
      .toBe(false);
  });

  it("reads a vector's notices as the catalog's block: its topic, and copy under the catalog rules", () => {
    const base = assertNotificationConformanceVector(readVector('advertising-notices.json'));
    expect(base.notices?.topic).toBe('consent-notice');
    const ko = base.notices?.copy['ko'];
    // Every variant but the advertising refusal, which is given in the withdrawal's text.
    expect(ko === undefined ? [] : Object.keys(ko).sort()).toEqual(
      notificationNoticeVariants.filter((variant) => variant !== 'consent-result.advertising.refused').sort(),
    );
    const withCopy = (copy: unknown) => ({ ...base, notices: { topic: 'consent-notice', copy } });
    expect(isNotificationConformanceVector(withCopy({ ko }))).toBe(true);
    expect(isNotificationConformanceVector({ ...base, notices: { copy: { ko } } })).toBe(false);
    if (ko !== undefined) {
      const { 'reconfirmation.night': _night, ...withoutNight } = ko;
      const night = (title: string, body: string) => withCopy({ ko: { ...ko, 'reconfirmation.night': { title, body } } });
      expect(isNotificationConformanceVector(withCopy({ ko: withoutNight }))).toBe(false);
      // The catalog rules, read in the runner's default locale ko.
      expect(() => assertNotificationConformanceVector(withCopy({ en: ko })))
        .toThrow('notices.copy: must include the default locale ko');
      expect(() => assertNotificationConformanceVector(night(' ', '{{consentDate}}')))
        .toThrow('notices.copy["ko"]["reconfirmation.night"].title: a notice\'s title must not be blank');
      expect(() => assertNotificationConformanceVector(night('확인', '확인')))
        .toThrow('notices.copy["ko"]["reconfirmation.night"]: a notice states the date');
      expect(() => assertNotificationConformanceVector(night('확인', '{consentDate}')))
        .toThrow('a brace outside a {{name}} placeholder');
      // A refusal's text is optional, and follows the same rules when given.
      const refusal = { title: '거부', body: '{{consentDate}}에 거부하셨어요.' };
      expect(isNotificationConformanceVector(withCopy({ ko: { ...ko, 'consent-result.advertising.refused': refusal } })))
        .toBe(true);
      expect(() => assertNotificationConformanceVector(withCopy({
        ko: { ...ko, 'consent-result.advertising.refused': { ...refusal, body: '거부하셨어요.' } },
      }))).toThrow('notices.copy["ko"]["consent-result.advertising.refused"]: a notice states the date');
      expect(isNotificationConformanceVector(withCopy({ ko: { ...ko, 'consent-result.night.denied': refusal } })))
        .toBe(false);
    }
  });

  it('explains why a provider does not satisfy appliesTo', () => {
    const unsupported = createUnsupportedNotificationCapabilities();
    expect(notificationConformanceAppliesToReason([{ path: 'availability', equals: 'unsupported' }], unsupported))
      .toBeUndefined();
    expect(notificationConformanceAppliesToReason([{ path: 'permission.prompt', equals: 'host' }], unsupported))
      .toBe('appliesTo permission.prompt equals "host"; the provider declares "os"');
    expect(notificationConformanceAppliesToReason(
      [{ path: 'remote.purposes', includes: 'advertising' }],
      unsupported,
    )).toBe('appliesTo remote.purposes includes "advertising"; the provider declares []');
    expect(notificationConformanceAppliesToReason(
      [{ path: 'remote.purposes', excludes: 'advertising' }],
      unsupported,
    )).toBeUndefined();
    expect(notificationConformanceAppliesToReason([{ path: 'open', includes: 'payload' }], unsupported))
      .toBe('appliesTo open needs a list; the provider declares "none"');
    expect(notificationConformanceAppliesToReason([{ path: 'local.maxPending', equals: 64 }], unsupported))
      .toBe('appliesTo local.maxPending names no declared capability');
    expect(notificationConformanceVectorNameOf('docs/specs/notifications/vectors/os-permission-granted.json'))
      .toBe('os-permission-granted');
  });
});
