import { describe, expect, it } from 'vitest';

import {
  createUnsupportedPlatformAnalyticsSink,
  platformAnalyticsParamLimit,
  readPlatformAnalyticsLog,
  readPlatformAnalyticsStatus,
} from './analytics.js';

describe('readPlatformAnalyticsLog', () => {
  it('keeps a bounded log as a fresh frozen copy', () => {
    const params = { kind: 'daily', stage: 3, ranked: true, help_type: 'hint' };
    const log = readPlatformAnalyticsLog({ logName: 'nem_play_clear', logType: 'event', params });
    expect(log).toEqual({ logName: 'nem_play_clear', logType: 'event', params });
    expect(log?.params).not.toBe(params);
    expect(Object.isFrozen(log)).toBe(true);
    expect(Object.isFrozen(log?.params)).toBe(true);
    expect(readPlatformAnalyticsLog({ logName: 'home_screen', logType: 'screen' }))
      .toEqual({ logName: 'home_screen', logType: 'screen', params: {} });
    for (const logType of ['click', 'impression']) {
      expect(readPlatformAnalyticsLog({ logName: 'shop_button', logType })?.logType).toBe(logType);
    }
  });

  it('refuses names, types, and shapes outside the bounds', () => {
    const invalid: readonly unknown[] = [
      undefined,
      null,
      'nem_play_start',
      [],
      new (class Log { logName = 'nem_play'; logType = 'event'; })(),
      { logName: 'nem_play', logType: 'debug' },
      { logName: 'nem_play', logType: 'popup' },
      { logName: 'Nem_play', logType: 'event' },
      { logName: '_play', logType: 'event' },
      { logName: 'a', logType: 'event' },
      { logName: 'nem-play', logType: 'event' },
      { logName: `n${'a'.repeat(64)}`, logType: 'event' },
      { logName: 'nem_play', logType: 'event', params: [] },
      { logName: 'nem_play', logType: 'event', params: null },
      { logName: 'nem_play', logType: 'event', params: new Map() },
    ];
    for (const value of invalid) {
      expect(readPlatformAnalyticsLog(value), JSON.stringify(value) ?? String(value)).toBeUndefined();
    }
    expect(readPlatformAnalyticsLog({ logName: `n${'a'.repeat(63)}`, logType: 'event' })).toBeDefined();
  });

  it('drops the whole log for any invalid parameter', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: platformAnalyticsParamLimit + 1 }, (_, index) => [`p${index}`, index]),
    );
    const atLimit = Object.fromEntries(Object.entries(tooMany).slice(0, platformAnalyticsParamLimit));
    expect(readPlatformAnalyticsLog({ logName: 'nem_play', logType: 'event', params: atLimit })).toBeDefined();
    const invalidParams: readonly Readonly<Record<string, unknown>>[] = [
      tooMany,
      { Kind: 'daily' },
      { 'kind-name': 'daily' },
      { [`k${'a'.repeat(32)}`]: 1 },
      { nested: { a: 1 } },
      { list: [1] },
      { nothing: null },
      { missing: undefined },
      { big: 10n },
      { infinite: Number.POSITIVE_INFINITY },
      { nan: Number.NaN },
      { big_number: 1e15 },
      { negative: -1234567890123456 },
      { text: 'x'.repeat(65) },
      { text: 'line\nbreak' },
    ];
    for (const [index, params] of invalidParams.entries()) {
      expect(readPlatformAnalyticsLog({ logName: 'nem_play', logType: 'event', params }), `params #${index}`)
        .toBeUndefined();
    }
    expect(readPlatformAnalyticsLog({ logName: 'nem_play', logType: 'event', params: { text: 'x'.repeat(64) } }))
      .toBeDefined();
    expect(readPlatformAnalyticsLog({ logName: 'nem_play', logType: 'event', params: { duration_ms: 999_999_999_999_999 } }))
      .toBeDefined();
  });

  it('refuses parameter names and values that look like identifiers or scores', () => {
    for (const key of [
      'id',
      'user_id',
      'room_id',
      'account_ids',
      'player_uid',
      'match_uuid',
      'anonymous_key',
      'session_token',
      'email',
      'score',
      'best_score',
      'userid',
      'roomid',
      'accountids',
      'highscore',
      'user_id_hash',
      'score_band_label',
      'key_count',
      'log_name',
      'log_type',
      'params',
    ]) {
      expect(readPlatformAnalyticsLog({ logName: 'nem_play', logType: 'event', params: { [key]: 'x' } }), key)
        .toBeUndefined();
    }
    for (const value of [
      'jane@example.com',
      'https://example.com/r/abc',
      '3f9a6c1e0b7d4a2f',
      '123456789012345678',
      '550e8400-e29b-41d4-a716-446655440000',
      'room_Ab3dEf7hIj9kLm1nOp3qRs5tUv7wXy9z',
      'aaaaaaaaaaaaaaaa 0123456789abcdef',
      '---------------- 0123456789abcdef',
    ]) {
      expect(readPlatformAnalyticsLog({ logName: 'nem_play', logType: 'event', params: { kind: value } }), value)
        .toBeUndefined();
    }
    for (const value of ['daily', 'stage-12', '2026-11-01', 'numbered', 'help_hint', 'NoDigitsButQuiteALongWordForAnalyticsValue']) {
      expect(readPlatformAnalyticsLog({ logName: 'nem_play', logType: 'event', params: { kind: value } }), value)
        .toBeDefined();
    }
    for (const key of ['kind', 'theme', 'stage', 'outcome', 'idle', 'keyboard', 'player_count', 'level_band', 'tokenless', 'idle_seconds']) {
      expect(readPlatformAnalyticsLog({ logName: 'nem_play', logType: 'event', params: { [key]: 1 } }), key)
        .toBeDefined();
    }
  });

  it('treats a throwing getter as no log', () => {
    const hostile = {
      logName: 'nem_play',
      get logType(): string {
        throw new Error('boom');
      },
    };
    expect(readPlatformAnalyticsLog(hostile)).toBeUndefined();
  });
});

describe('readPlatformAnalyticsStatus', () => {
  it('keeps known, distinct log types in canonical order', () => {
    expect(readPlatformAnalyticsStatus({
      provider: 'apps-in-toss',
      state: 'available',
      logTypes: ['click', 'screen', 'popup', 'click'],
    })).toEqual({ provider: 'apps-in-toss', state: 'available', logTypes: ['screen', 'click'] });
    expect(readPlatformAnalyticsStatus({ provider: 'apps-in-toss', state: 'unsupported', logTypes: ['event'] }))
      .toEqual({ provider: 'apps-in-toss', state: 'unsupported', logTypes: [] });
  });

  it('refuses answers that are not a status', () => {
    for (const value of [
      undefined,
      {},
      { provider: '', state: 'available', logTypes: [] },
      { provider: 'x'.repeat(65), state: 'available', logTypes: [] },
      { provider: 'apps\nin-toss', state: 'available', logTypes: [] },
      { provider: 'https://example.com', state: 'available', logTypes: [] },
      { provider: 'apps-in-toss', state: 'ready', logTypes: [] },
      { provider: 'apps-in-toss', state: 'available', logTypes: 'event' },
    ]) {
      expect(readPlatformAnalyticsStatus(value)).toBeUndefined();
    }
  });
});

describe('createUnsupportedPlatformAnalyticsSink', () => {
  it('reports unsupported and drops every log', async () => {
    const sink = createUnsupportedPlatformAnalyticsSink();
    await expect(sink.getStatus()).resolves.toEqual({ provider: 'none', state: 'unsupported', logTypes: [] });
    await expect(sink.log({ logName: 'nem_play', logType: 'event' })).resolves.toBe(false);
  });
});
