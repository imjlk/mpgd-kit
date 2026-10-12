import { describe, expect, it } from 'vitest';

import { rootRelativeRouteVectors } from './route-vectors.js';
import {
  hasNetworkPathPrefix,
  hasRouteControlCharacter,
  normalizeRootRelativeRoute,
} from './routes.js';

const decodeOnce = (value: string) =>
  value.replace(/%([0-7][0-9a-f])/giu, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/** Where a client lands when it decodes the path once, routes it as a path, and resolves the result again. */
function landsOn(route: string, base: string): readonly string[] {
  const { pathname, search, hash } = new URL(route, base);
  const decodedPath = decodeOnce(pathname).replace(/\?/gu, '%3F').replace(/#/gu, '%23');
  const asPath = new URL(`${decodedPath}${search}${hash}`, base);
  const asPathAgain = new URL(`${asPath.pathname}${asPath.search}${asPath.hash}`, base);
  const whole = new URL(decodeOnce(route), base);
  const wholeAgain = new URL(`${whole.pathname}${whole.search}${whole.hash}`, base);

  return [new URL(route, base), asPath, asPathAgain, whole, wholeAgain].map((url) => url.origin);
}

describe('root-relative routes', () => {
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
      expect(hasNetworkPathPrefix(new URL(route, 'https://game.example').pathname), route).toBe(false);
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
    ]) {
      expect(hasNetworkPathPrefix(path), path).toBe(true);
    }

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

  it('never answers a route that leaves the origin, as written, once decoded, or resolved again', () => {
    const tokens = ['/', '\\', '.', '..', '%2e', '%2f', '%5c', '%09', '%25', '%3f', '%23', 'x', '?', '#'];
    const base = 'https://game.example/';
    const problems: string[] = [];
    let accepted = 0;

    const visit = (suffix: string, depth: number) => {
      const input = `/${suffix}`;
      const route = normalizeRootRelativeRoute(input);

      if (route !== undefined) {
        accepted += 1;

        if (
          landsOn(route, base).some((origin) => origin !== 'https://game.example')
          || normalizeRootRelativeRoute(route) !== route
        ) {
          problems.push(`${JSON.stringify(input)} -> ${route}`);
        }
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
});
