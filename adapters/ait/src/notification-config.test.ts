import { describe, expect, it } from 'vitest';

import { posix } from 'node:path';

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

describe('extractAitNotificationTopicConfig', () => {
  it('maps every topic the target maps, trimming the template code', () => {
    expect(extractAitNotificationTopicConfig(catalog)).toEqual({
      'daily-ready': { templateSetCode: 'game-daily-ready', agreement: 'required' },
      'purchase-result': { templateSetCode: 'game-purchase', agreement: 'none' },
    });
  });

  it('reads another target name when the deployment calls it differently', () => {
    expect(extractAitNotificationTopicConfig({
      topics: [{ id: 'daily-ready', purpose: 'requested', targets: { 'ait-kr': { templateSetCode: 'x', agreement: 'required' } } }],
    }, { target: 'ait-kr' })).toEqual({ 'daily-ready': { templateSetCode: 'x', agreement: 'required' } });
  });

  it('answers no topics for a catalog without an Apps in Toss mapping', () => {
    expect(extractAitNotificationTopicConfig({ topics: [] })).toEqual({});
  });

  it('refuses what would reach a player wrongly, naming the source', () => {
    const refusals: readonly [unknown, RegExp][] = [
      [null, /catalog is invalid: topics\.json/u],
      [{ topics: 'x' }, /catalog is invalid/u],
      [{ topics: [{ id: '' }] }, /index 0 is invalid/u],
      [{ topics: [{ id: 'a' }, { id: 'a' }] }, /Duplicate notification topic "a"/u],
      [JSON.parse('{"topics":[{"id":"__proto__","targets":{"ait":{"templateSetCode":"c","agreement":"required"}}}]}'), /index 0 is invalid/u],
      [{ topics: [{ id: 'a', targets: 'ait' }] }, /"a" has invalid targets/u],
      [{ topics: [{ id: 'a', targets: [] }] }, /"a" has invalid targets/u],
      [{ topics: [{ id: 'a', targets: null }] }, /"a" has invalid targets/u],
      [{ topics: [{ id: 'a', targets: { ait: 'code' } }] }, /invalid ait mapping/u],
      [{ topics: [{ id: 'a', targets: { ait: { templateSetCode: ' ', agreement: 'required' } } }] }, /non-empty ait templateSetCode/u],
      [{ topics: [{ id: 'a', targets: { ait: { templateSetCode: 'c', agreement: 'optional' } } }] }, /agreement 'required' or 'none'/u],
      [{ topics: [{ id: 'a', purpose: 'advertising', targets: { ait: { templateSetCode: 'c', agreement: 'required' } } }] }, /advertising, which Apps in Toss cannot deliver/u],
    ];
    for (const [input, message] of refusals) {
      expect(() => extractAitNotificationTopicConfig(input, { sourceLabel: 'topics.json' })).toThrow(message);
    }
  });
});

describe('readAitNotificationTopicsFile', () => {
  const catalogText = JSON.stringify({
    topics: [{ id: 'daily-ready', purpose: 'requested', targets: { ait: { templateSetCode: 'c', agreement: 'required' } } }],
  });
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
