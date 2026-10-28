import { describe, expect, it, vi } from 'vitest';

import { rootRelativeRouteVectors, shareLinkVectors } from './route-vectors.js';
import {
  hasNetworkPathPrefix,
  hasRouteControlCharacter,
  isHostedGameServicesPath,
  normalizeRootRelativeRoute,
  normalizeShareLink,
} from './routes.js';

const base = 'https://game.example/';

const decodeOnce = (value: string) =>
  value.replace(/%([0-7][0-9a-f])/giu, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

const keepDelimiters = (path: string) => path.replace(/\?/gu, '%3F').replace(/#/gu, '%23');

/**
 * Where a client lands when it reads a route as written, or decodes it once
 * (the whole route, or the path ended at any decoded `?` or `#`, or none),
 * and then resolves the result again, twice.
 */
function landsOn(route: string): readonly string[] {
  const { pathname, search, hash } = new URL(route, base);
  const decodedPath = decodeOnce(pathname);
  const ends = [...decodedPath.matchAll(/[?#]/gu)].map((match) => match.index);
  const readings = [...ends, decodedPath.length].map(
    (end) => `${keepDelimiters(decodedPath.slice(0, end))}${search}${hash}`,
  );
  const origins: string[] = [];

  for (const first of [route, decodeOnce(route), ...readings]) {
    let url = new URL(first, base);
    origins.push(url.origin);

    for (let again = 0; again < 2; again += 1) {
      url = new URL(`${url.pathname}${url.search}${url.hash}`, base);
      origins.push(url.origin);
    }
  }

  return origins;
}

/** Normalizes `input` and describes the problem when an accepted route can leave the origin or is not stable. */
function problemWith(input: string): string | undefined {
  const route = normalizeRootRelativeRoute(input);

  if (route === undefined) {
    return undefined;
  }

  try {
    if (landsOn(route).some((origin) => origin !== 'https://game.example')) {
      return `${JSON.stringify(input)} -> ${route} leaves the origin`;
    }
  } catch {
    return `${JSON.stringify(input)} -> ${route} does not parse for every reading`;
  }

  return normalizeRootRelativeRoute(route) === route
    ? undefined
    : `${JSON.stringify(input)} -> ${route} does not normalize to itself`;
}

describe('root-relative routes', () => {
  it('normalizes without a URL global', () => {
    vi.stubGlobal('URL', undefined);
    try {
      for (const [input, route] of rootRelativeRouteVectors.normalized) {
        expect(normalizeRootRelativeRoute(input), input).toBe(route);
      }
      for (const input of rootRelativeRouteVectors.rejected) {
        expect(normalizeRootRelativeRoute(input), input).toBeUndefined();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('matches HTTP(S) URL component serialization and dot segments', () => {
    const components = ['', ' ', 'é', '😀', '\uD800', '\uDC00', "'", '"', '<', '>', '^', '`', '{', '}', '[', ']', '\\', '%', '%2e', '%2E%2e', '..', '.', '%2f', '%3f', '?', '#'];
    for (const part of components) {
      for (const input of [`/a/${part}/b`, `/a/${part}`, `/a?q=${part}#tail`, `/a#${part}`, `/a/${part}/../b`]) {
        const parsed = new URL(input, base);
        const expected = hasNetworkPathPrefix(parsed.pathname)
          ? undefined
          : `${parsed.pathname}${parsed.search}${parsed.hash}`;
        expect(normalizeRootRelativeRoute(input), JSON.stringify(input)).toBe(expected);
      }
    }
  });

  it('normalizes routes that stay on the origin, and a normalized route normalizes to itself', () => {
    for (const [input, route] of rootRelativeRouteVectors.normalized) {
      expect(normalizeRootRelativeRoute(input), input).toBe(route);
      expect(normalizeRootRelativeRoute(route), route).toBe(route);
    }
  });

  it('refuses routes a client could read as another host, and inputs that are not root-relative', () => {
    for (const input of rootRelativeRouteVectors.rejected) {
      expect(normalizeRootRelativeRoute(input), JSON.stringify(input)).toBeUndefined();
    }

    for (const input of ['', 'daily', './daily', '?q=1', ' /daily', 'https://game.example/daily', '\\\\evil.example/daily']) {
      expect(normalizeRootRelativeRoute(input), JSON.stringify(input)).toBeUndefined();
    }
  });

  it('flags only normalized paths with a network-path prefix', () => {
    for (const [, route] of rootRelativeRouteVectors.normalized) {
      expect(hasNetworkPathPrefix(new URL(route, base).pathname), route).toBe(false);
    }

    for (const path of [
      '//evil.example',
      '/%2F/evil.example',
      '/%5Cevil.example',
      '/%09/evil.example',
      '/.%2F/evil.example',
      '/%2e%2e%2f%2fevil.example',
      '/%3F%2F..%2F%2Fevil.example',
      '/%23%2F..%2F%2Fevil.example',
      '/.%2F%2Fevil.example%3F%2F..%2F..',
      '/a%3Fb%23%2F..%2F%2Fevil.example',
      '/a%23%2F..%2F%2Fevil.example%3F%2F..%2F..',
      '/a%3F%2F..%2F%2Fevil.example%23%2F..%2F..',
      '/a%3F%2F..%2F%2Fevil.example%3F%2F..%2F..',
    ]) {
      expect(hasNetworkPathPrefix(path), path).toBe(true);
    }

    // A trailing space before a delimiter stays in the path, as it does when the rest of the link
    // follows: `/.//.. ` names the host `..%20` (refused, as on main), not `/` once stripped.
    expect(hasNetworkPathPrefix('/.%2F%2F..%20%3F%2F..%2F..')).toBe(true);
    expect(hasNetworkPathPrefix('/.%2F%2F..%01%23%2F..%2F..')).toBe(true);

    // Each decoded `?` or `#` is a reading to parse, so past 16 of them a path is refused.
    expect(hasNetworkPathPrefix(`/q${'%3F'.repeat(16)}`)).toBe(false);
    expect(hasNetworkPathPrefix(`/q${'%3F'.repeat(8)}${'%23'.repeat(9)}`)).toBe(true);
    expect(normalizeRootRelativeRoute(`/q${'%3F'.repeat(16)}`)).toBe(`/q${'%3F'.repeat(16)}`);
    expect(normalizeRootRelativeRoute(`/q${'%3F'.repeat(17)}`)).toBeUndefined();

    // Anything that is not a URL path fails closed instead of throwing.
    for (const value of ['', 'evil.example', 'https://[x', '\\\\evil.example']) {
      expect(hasNetworkPathPrefix(value), value).toBe(true);
    }
  });

  it('detects ASCII control characters only', () => {
    expect(hasRouteControlCharacter('/a\u0000')).toBe(true);
    expect(hasRouteControlCharacter('/a\u001f')).toBe(true);
    expect(hasRouteControlCharacter('/a\u007f')).toBe(true);
    expect(hasRouteControlCharacter('/a\u0080')).toBe(false);
    expect(hasRouteControlCharacter('/a b')).toBe(false);
  });

  it('accepts no short route that leaves the origin as written, once decoded, or resolved again', () => {
    const tokens = ['/', '\\', '.', '..', '%2e', '%2f', '%5c', '%09', '%25', '%3f', '%23', 'x', '?', '#'];
    const problems: string[] = [];
    let accepted = 0;

    const visit = (suffix: string, depth: number) => {
      const input = `/${suffix}`;

      if (normalizeRootRelativeRoute(input) !== undefined) {
        accepted += 1;
      }

      const problem = problemWith(input);

      if (problem !== undefined) {
        problems.push(problem);
      }

      if (depth > 0) {
        for (const token of tokens) {
          visit(`${suffix}${token}`, depth - 1);
        }
      }
    };

    visit('', 4);
    expect(accepted).toBeGreaterThan(1_000);
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('accepts no longer route that hides a host behind slashes, delimiters, and dot segments', () => {
    // Escapes need a lead that collapses (or hides `..` behind a delimiter), two slashes, a host, a
    // delimiter, and `..` segments that pop the host for one reading: too long for the search above.
    const leads = [
      '',
      'a/',
      '.',
      '..',
      '%2e',
      '%2e%2e',
      'a/..',
      'a%2F..',
      '.%2F',
      '%2e%2F',
      '%3F%2F..',
      'a%3F%2F..',
      'a%23%2F..',
      'a%3Fb%23%2F..',
    ];
    const slashes = ['/', '\\', '%2F', '%5C', '%2F%2F', '%5C%5C', '/%2F', '%2F/', '%09/', '%2F%09%2F'];
    const delimiters = ['', '?', '#', '%3F', '%23', '%3F%23', '%23%3F', '%253F', '#%3F', '%23?'];
    const tails = [
      '',
      '/..',
      '%2F..',
      '/../..',
      '%2F..%2F..',
      '/..%2F..',
      '%2F..%2F..%2F..',
      '/../../..',
      '%2F%2e%2e%2F%2e%2e',
      '%2F.%2F..%2F..',
    ];
    const problems: string[] = [];

    for (const lead of leads) {
      for (const slash of slashes) {
        for (const delimiter of delimiters) {
          for (const tail of tails) {
            const problem = problemWith(`/${lead}${slash}evil.example${delimiter}${tail}`);

            if (problem !== undefined) {
              problems.push(problem);
            }
          }
        }
      }
    }

    expect(problems.slice(0, 10)).toEqual([]);
  });
});

describe('share links', () => {
  it('normalizes root-relative routes and absolute HTTP(S) links', () => {
    for (const [input, route] of rootRelativeRouteVectors.normalized) {
      expect(normalizeShareLink(input), input).toBe(route);
    }

    for (const [input, link] of shareLinkVectors.normalized) {
      expect(normalizeShareLink(input), input).toBe(link);
      expect(normalizeShareLink(link), link).toBe(link);
    }
  });

  it('refuses route escapes and links outside the ShareIntent contract', () => {
    for (const input of [...rootRelativeRouteVectors.rejected, ...shareLinkVectors.rejected]) {
      expect(normalizeShareLink(input), JSON.stringify(input)).toBeUndefined();
    }
  });

  it('keeps an absolute link on the host it names, with a path that stays there', () => {
    for (const [, link] of shareLinkVectors.normalized) {
      const url = new URL(link);

      expect(url.username + url.password, link).toBe('');
      expect(hasNetworkPathPrefix(url.pathname), link).toBe(false);
    }
  });
});

describe('isHostedGameServicesPath', () => {
  it('accepts /api and clean segments below it, and refuses anything a URL parser could move', () => {
    const accepted = [
      '/api',
      '/api/',
      '/api/game-services',
      '/api/game-services/',
      '/api/game_services/v1',
    ];
    const rejected = [
      '',
      'api',
      'api/game-services',
      '/',
      '/other',
      '/apiary',
      '/API',
      '//api',
      '//evil.example/api',
      '/\\evil.example/api',
      '/api\\evil.example',
      '/api//evil.example',
      '/api/../admin',
      '/api/./game-services',
      '/api/..',
      '/api/%2e%2e/admin',
      '/api/%2f%2fevil.example',
      '/api/game%20services',
      '/api/game services',
      ' /api',
      '/api ',
      '/api\t',
      '/api\n',
      '/api?redirect=other',
      '/api/?x=1',
      '/api#fragment',
      '/api/game-services#x',
      'https://game.example/api',
      '/api/ga\u00efme',
    ];

    for (const path of accepted) {
      expect(isHostedGameServicesPath(path), JSON.stringify(path)).toBe(true);
    }
    for (const path of rejected) {
      expect(isHostedGameServicesPath(path), JSON.stringify(path)).toBe(false);
    }
  });
});
