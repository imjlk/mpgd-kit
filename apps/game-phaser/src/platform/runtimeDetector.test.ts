import { describe, expect, it } from 'vitest';

import { normalizeConfigTarget, normalizeTarget } from './runtimeDetector';

describe('runtimeDetector', () => {
  it('preserves supported deployment targets', () => {
    expect(normalizeTarget('android')).toBe('android');
    expect(normalizeTarget('ios')).toBe('ios');
    expect(normalizeTarget('ait')).toBe('ait');
    expect(normalizeTarget('reddit')).toBe('reddit');
  });

  it('falls back to browser for unknown targets', () => {
    expect(normalizeTarget('unknown')).toBe('browser');
  });

  it('preserves an explicit config target for web builds', () => {
    expect(normalizeConfigTarget('microsoft-store', 'browser')).toBe('microsoft-store');
  });

  it('maps browser config to web-preview when no config target is injected', () => {
    expect(normalizeConfigTarget('', 'browser')).toBe('web-preview');
  });
});
