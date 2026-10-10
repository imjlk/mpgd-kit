import { describe, expect, it } from 'vitest';

import { aitBrowserOrigins, isAitBrowserOrigin } from './origins';

describe('AIT browser origins', () => {
  it('returns the web and apps origin pairs for an app name', () => {
    expect(aitBrowserOrigins('my-game')).toEqual([
      'https://my-game.web.tossmini.com',
      'https://my-game.private-web.tossmini.com',
      'https://my-game.apps.tossmini.com',
      'https://my-game.private-apps.tossmini.com',
    ]);
    expect(Object.isFrozen(aitBrowserOrigins('my-game'))).toBe(true);
  });

  it('normalizes the app name to the lower-case host browsers send', () => {
    expect(aitBrowserOrigins(' My-Game ')[0]).toBe('https://my-game.web.tossmini.com');
  });

  it('rejects app names that are not a single DNS label', () => {
    for (const appName of [
      '',
      '-game',
      'game-',
      'my.game',
      'my game',
      'game/path',
      'a'.repeat(64),
    ]) {
      expect(() => aitBrowserOrigins(appName)).toThrow(TypeError);
    }
    expect(() => aitBrowserOrigins(undefined as unknown as string)).toThrow(TypeError);
  });

  it('matches only exact allowed origins', () => {
    expect(isAitBrowserOrigin('my-game', 'https://my-game.private-apps.tossmini.com')).toBe(true);
    expect(isAitBrowserOrigin('my-game', 'https://other.web.tossmini.com')).toBe(false);
    expect(isAitBrowserOrigin('my-game', 'https://my-game.web.tossmini.com/')).toBe(false);
    expect(isAitBrowserOrigin('my-game', 'http://my-game.web.tossmini.com')).toBe(false);
    expect(isAitBrowserOrigin('my-game', null)).toBe(false);
  });
});
