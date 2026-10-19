import { describe, expect, it } from 'vitest';

import { posix } from 'node:path';

import { validateNotificationTopicCatalog } from '@mpgd/catalog';
import { referenceNotificationProviders } from '@mpgd/platform/notifications';

import {
  extractAitNotificationTopicConfig,
  readAitNotificationTopicsFile,
  type AitNotificationTopicsFileSystem,
} from './notification-config';

const catalog = {
  version: '2026-10-19',
  defaultLocale: 'ko',
  topics: [
    {
      id: 'daily-ready',
      purpose: 'requested',
      channels: ['remote'],
      route: '/',
      targets: { ait: { templateSetCode: ' game-daily-ready ', agreement: 'required' } },
    },
    {
      id: 'purchase-result',
      purpose: 'service',
      channels: ['remote'],
      route: '/',
      copy: { ko: { title: '구매 완료', body: '아이템이 도착했어요.' } },
      targets: { ait: { templateSetCode: 'game-purchase', agreement: 'none' }, android: {} },
    },
    {
      id: 'android-only',
      purpose: 'service',
      channels: ['remote'],
      route: '/',
      targets: { android: { channelId: 'notices' } },
    },
    { id: 'no-targets', purpose: 'service', channels: ['remote'], route: '/' },
  ],
};

type Topic = (typeof catalog.topics)[number] | Readonly<Record<string, unknown>>;
const withTopics = (...topics: readonly Topic[]) => ({ ...catalog, topics });
const aitTopic = (fields: Readonly<Record<string, unknown>> = {}, mapping: unknown = {
  templateSetCode: 'c',
  agreement: 'required',
}) => ({
  id: 'a',
  purpose: 'requested',
  channels: ['remote'],
  route: '/',
  targets: { ait: mapping },
  ...fields,
});

describe('extractAitNotificationTopicConfig', () => {
  it('maps every topic the target maps, trimming the template code', () => {
    expect(extractAitNotificationTopicConfig(catalog)).toEqual({
      'daily-ready': { templateSetCode: 'game-daily-ready', agreement: 'required' },
      'purchase-result': { templateSetCode: 'game-purchase', agreement: 'none' },
    });
  });

  it('reads another target name when the deployment calls it differently', () => {
    expect(extractAitNotificationTopicConfig(withTopics({
      id: 'daily-ready',
      purpose: 'requested',
      channels: ['remote'],
      route: '/',
      targets: { 'ait-kr': { templateSetCode: 'x', agreement: 'required' } },
    }), { target: 'ait-kr' })).toEqual({ 'daily-ready': { templateSetCode: 'x', agreement: 'required' } });
  });

  it('answers no topics for a catalog without an Apps in Toss mapping', () => {
    expect(extractAitNotificationTopicConfig(withTopics())).toEqual({});
  });

  it('accepts a catalog with an advertising topic elsewhere without the deployment', () => {
    // The deployment's checks are `pnpm validate:notifications`'s; the wrapper
    // reads only the topics, and Apps in Toss is not offered the advertising one.
    const advertising = {
      id: 'events',
      purpose: 'advertising',
      channels: ['remote'],
      route: '/',
      optOutRoute: '/?entry=notification-settings',
      copy: { ko: { title: '이벤트', body: '새 이벤트가 열렸어요.' } },
      targets: { ios: {} },
    };
    const input = withTopics(catalog.topics[0]!, advertising);
    expect(validateNotificationTopicCatalog(input).issues.map((issue) => issue.path))
      .toEqual(['deployment.advertisingRules']);
    expect(extractAitNotificationTopicConfig(input)).toEqual({
      'daily-ready': { templateSetCode: 'game-daily-ready', agreement: 'required' },
    });
  });

  it('refuses what would reach a player wrongly, naming the source', () => {
    const refusals: readonly [unknown, RegExp][] = [
      [null, /catalog is invalid: topics\.json/u],
      [{ ...catalog, topics: 'x' }, /catalog is invalid/u],
      [{ topics: [] }, /catalog is invalid: topics\.json\n- version/u],
      [withTopics(aitTopic({ id: '' })), /catalog is invalid/u],
      [withTopics(aitTopic(), aitTopic()), /duplicates the id of topics\[0\]: a/u],
      [JSON.parse(JSON.stringify(withTopics(aitTopic())).replace('"id":"a"', '"id":"__proto__"')), /topics\[0\]\.id/u],
      [withTopics(aitTopic({ targets: 'ait' })), /topics\[0\]\.targets/u],
      [withTopics(aitTopic({ targets: [] })), /topics\[0\]\.targets/u],
      [withTopics(aitTopic({ targets: null })), /topics\[0\]\.targets/u],
      [withTopics(aitTopic({}, 'code')), /topics\[0\]\.targets\.ait/u],
      [withTopics(aitTopic({}, { templateSetCode: ' ', agreement: 'required' })), /needs a non-empty templateSetCode/u],
      [withTopics(aitTopic({}, { agreement: 'required' })), /templateSetCode/u],
      [withTopics(aitTopic({}, { templateSetCode: 'c', agreement: 'optional' })), /agreement/u],
      // Refused by the catalog's own rules, which the wrapper used to skip.
      [withTopics(aitTopic({ route: 'https://evil.example/' })), /topics\[0\]\.route/u],
      [withTopics(aitTopic({ channels: [] })), /topics\[0\]\.channels/u],
      [withTopics(aitTopic({ copy: { en: { title: 't', body: 'b' } } })), /default locale ko/u],
      [
        withTopics(aitTopic({ purpose: 'advertising', optOutRoute: '/?entry=notification-settings' })),
        /topics\[0\]\.targets\.ait/u,
      ],
    ];
    for (const [input, message] of refusals) {
      expect(() => extractAitNotificationTopicConfig(input, { sourceLabel: 'topics.json' }), String(message))
        .toThrow(message);
    }
  });

  it('accepts and refuses the same catalogs as validateNotificationTopicCatalog with the Apps in Toss entry', () => {
    const entry = referenceNotificationProviders['apps-in-toss'];
    const inputs: readonly unknown[] = [
      catalog,
      withTopics(aitTopic({ route: '//evil.example' })),
      withTopics(aitTopic({}, { templateSetCode: 'c' })),
      withTopics(aitTopic({}, { templateSetCode: ' ', agreement: 'required' })),
      withTopics(aitTopic({ quietHours: { start: '22:00', end: '22:00' } })),
      { ...catalog, defaultLocale: '' },
      withTopics(aitTopic(), { ...aitTopic(), id: 'b', targets: { android: {} } }),
    ];
    for (const input of inputs) {
      const valid = validateNotificationTopicCatalog(input, { targetProviders: { ait: entry } }).valid;
      let accepted = true;
      try {
        extractAitNotificationTopicConfig(input);
      } catch {
        accepted = false;
      }
      expect(accepted, JSON.stringify(input)).toBe(valid);
    }
  });
});

describe('readAitNotificationTopicsFile', () => {
  const catalogText = JSON.stringify(withTopics({
    id: 'daily-ready',
    purpose: 'requested',
    channels: ['remote'],
    route: '/',
    targets: { ait: { templateSetCode: 'c', agreement: 'required' } },
  }));
  const mapped = { 'daily-ready': { templateSetCode: 'c', agreement: 'required' } };
  const fileSystem = (files: Readonly<Record<string, string>>): AitNotificationTopicsFileSystem => ({
    existsSync: (path) => Object.prototype.hasOwnProperty.call(files, path),
    readFileSync: (path) => {
      const text = files[path];
      if (text === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return text;
    },
    resolve: (...paths) => posix.resolve(...paths),
  });

  it('reads the default file when nothing is configured, and no topics without it', () => {
    const input = { configured: undefined, rootDir: '/game', defaultFile: 'notifications/topics.json' };
    expect(readAitNotificationTopicsFile(input, fileSystem({ '/game/notifications/topics.json': catalogText })))
      .toEqual(mapped);
    expect(readAitNotificationTopicsFile(input, fileSystem({}))).toEqual({});
    expect(readAitNotificationTopicsFile({ ...input, configured: '  ' }, fileSystem({}))).toEqual({});
    // A default file that exists but cannot be read fails with its path.
    const unreadable = { ...fileSystem({}), existsSync: () => true };
    expect(() => readAitNotificationTopicsFile(input, unreadable))
      .toThrow('unreadable or invalid JSON: /game/notifications/topics.json');
  });

  it('resolves a relative configured path against the game root, not the wrapper', () => {
    expect(readAitNotificationTopicsFile(
      { configured: ' config/topics.json ', rootDir: '/game', defaultFile: 'notifications/topics.json' },
      fileSystem({ '/game/config/topics.json': catalogText }),
    )).toEqual(mapped);
    expect(readAitNotificationTopicsFile(
      { configured: '/elsewhere/topics.json', rootDir: '/game', defaultFile: 'notifications/topics.json' },
      fileSystem({ '/elsewhere/topics.json': catalogText }),
    )).toEqual(mapped);
  });

  it('throws for a configured file that is missing or not JSON, naming the resolved path', () => {
    const input = { configured: 'missing.json', rootDir: '/game', defaultFile: 'notifications/topics.json' };
    expect(() => readAitNotificationTopicsFile(input, fileSystem({})))
      .toThrow('unreadable or invalid JSON: /game/missing.json (MPGD_NOTIFICATION_TOPICS_FILE)');
    expect(() => readAitNotificationTopicsFile(input, fileSystem({ '/game/missing.json': '{' })))
      .toThrow('unreadable or invalid JSON: /game/missing.json');
    expect(() => readAitNotificationTopicsFile(input, fileSystem({ '/game/missing.json': '[]' })))
      .toThrow('catalog is invalid: /game/missing.json');
  });
});
