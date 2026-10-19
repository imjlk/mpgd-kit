import { describe, expect, it } from 'vitest';

import { extractAitNotificationTopicConfig } from './notification-config';

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
