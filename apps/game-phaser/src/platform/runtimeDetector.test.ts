import { describe, expect, it } from 'vitest';

import { normalizeTarget } from './runtimeDetector';

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
});
