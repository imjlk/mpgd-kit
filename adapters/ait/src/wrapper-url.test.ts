import { describe, expect, it } from 'vitest';

import { rewriteAitGameBundleUrl } from './wrapper-url';

const origin = 'https://ttokdoku.example';

describe('rewriteAitGameBundleUrl', () => {
  it.each([
    ['assets/main.js', '/game/assets/main.js'],
    ['/assets/main.js', '/game/assets/main.js'],
    ['/game/assets/main.js', '/game/assets/main.js'],
    ['styles/main.css?theme=dark#sheet', '/game/styles/main.css?theme=dark#sheet'],
    [`${origin}/game/assets/main.js?v=1#entry`, '/game/assets/main.js?v=1#entry'],
    [`${origin}/assets/main.js`, '/game/assets/main.js'],
  ])('rewrites %s inside the game bundle root', (input, expected) => {
    expect(rewriteAitGameBundleUrl(input, origin)).toBe(expected);
  });

  it.each([
    '',
    '../escape.js',
    '../../escape.js',
    '//cdn.example/main.js',
    'https://evil.example/main.js',
    'javascript:alert(1)',
    '%2e%2e/escape.js',
    '%2fescape.js',
    '%5cescape.js',
    '%252e%252e/escape.js',
  ])('rejects unsafe asset URL %s', (input) => {
    expect(() => rewriteAitGameBundleUrl(input, origin)).toThrow();
  });
});
