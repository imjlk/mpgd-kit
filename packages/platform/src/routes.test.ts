import { describe, expect, it } from 'vitest';

import { rootRelativeRouteVectors } from './route-vectors.js';
import {
  hasNetworkPathPrefix,
  hasRouteControlCharacter,
  isCanonicalRootRelativeRoute,
  normalizeRootRelativeRoute,
} from './routes.js';

const decodeOnce = (value: string) =>
  value.replace(/%([0-7][0-9a-f])/giu, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

describe('root-relative routes', () => {
  it('normalizes routes that stay on the origin, and a normalized route normalizes to itself', () => {
    for (const [input, route] of rootRelativeRouteVectors.normalized) {
      expect(normalizeRootRelativeRoute(input), input).toBe(route);
      expect(normalizeRootRelativeRoute(route), route).toBe(route);
    }
  });

  it('refuses routes a client could read as another host, and inputs that are not root-relative', () => {
    for (const input of [...rootRelativeRouteVectors.rejected, ...rootRelativeRouteVectors.notRootRelative]) {
      expect(normalizeRootRelativeRoute(input), JSON.stringify(input)).toBeUndefined();
    }
  });

  it('flags only normalized paths with a network-path prefix', () => {
    for (const path of rootRelativeRouteVectors.onOriginPaths) {
      expect(hasNetworkPathPrefix(path), path).toBe(false);
    }

    for (const path of rootRelativeRouteVectors.networkPaths) {
      expect(hasNetworkPathPrefix(path), path).toBe(true);
    }

    // Anything that is not a URL path fails closed instead of throwing.
    for (const value of ['', 'evil.example', 'https://[x', '\\\\evil.example']) {
      expect(hasNetworkPathPrefix(value), value).toBe(true);
    }
  });

  it('accepts only canonical declared routes', () => {
    for (const route of rootRelativeRouteVectors.canonical) {
      expect(isCanonicalRootRelativeRoute(route), route).toBe(true);
      expect(normalizeRootRelativeRoute(route), route).toBe(route);
    }

    for (const route of rootRelativeRouteVectors.notCanonical) {
      expect(isCanonicalRootRelativeRoute(route), JSON.stringify(route)).toBe(false);
    }
  });

  it('detects ASCII control characters only', () => {
    expect(hasRouteControlCharacter('/a\u0000')).toBe(true);
    expect(hasRouteControlCharacter('/a\u001f')).toBe(true);
    expect(hasRouteControlCharacter('/a\u007f')).toBe(true);
    expect(hasRouteControlCharacter('/a\u0080')).toBe(false);
    expect(hasRouteControlCharacter('/a b')).toBe(false);
  });

  it('never answers a route that leaves the origin, directly, once decoded, or resolved again', () => {
    const tokens = ['/', '\\', '.', '..', '%2e', '%2f', '%5c', '%09', '%25', 'x', '?', '#', '@', ':'];
    const base = 'https://game.example/';
    const problems: string[] = [];
    let accepted = 0;

    const visit = (suffix: string, depth: number) => {
      const input = `/${suffix}`;
      const route = normalizeRootRelativeRoute(input);

      if (route !== undefined) {
        accepted += 1;
        const direct = new URL(route, base);
        const decoded = new URL(decodeOnce(route), base);
        const again = new URL(`${decoded.pathname}${decoded.search}${decoded.hash}`, base);

        if (
          direct.origin !== 'https://game.example'
          || decoded.origin !== 'https://game.example'
          || again.origin !== 'https://game.example'
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
