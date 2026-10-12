/**
 * Shared vectors for `@mpgd/platform/routes`. Every package that turns a
 * game-supplied link into a path on the game or mini-app origin runs these,
 * so a new escape is fixed once and caught everywhere.
 */
export interface RootRelativeRouteVectors {
  /** Root-relative inputs `normalizeRootRelativeRoute` accepts, with the route it returns. */
  readonly normalized: readonly (readonly [input: string, route: string])[];
  /** Root-relative inputs a client could read as another host: `normalizeRootRelativeRoute` answers `undefined`. */
  readonly rejected: readonly string[];
  /** Inputs that are not root-relative at all, which `normalizeRootRelativeRoute` also answers `undefined`. */
  readonly notRootRelative: readonly string[];
  /** Normalized paths that stay on the origin, which `hasNetworkPathPrefix` does not flag. */
  readonly onOriginPaths: readonly string[];
  /** Normalized paths a client could read as another host, which `hasNetworkPathPrefix` flags. */
  readonly networkPaths: readonly string[];
  /** Routes a project may declare: `isCanonicalRootRelativeRoute` accepts them. */
  readonly canonical: readonly string[];
  /** Routes `isCanonicalRootRelativeRoute` refuses, although some normalize safely. */
  readonly notCanonical: readonly string[];
}

export const rootRelativeRouteVectors: RootRelativeRouteVectors = {
  normalized: [
    ['/', '/'],
    ['/daily', '/daily'],
    ['/levels//3?from=push#start', '/levels//3?from=push#start'],
    ['/levels/../daily', '/daily'],
    ['/%2e%2e/levels', '/levels'],
    ['/?//x', '/?//x'],
    ['/#//x', '/#//x'],
    ['/a/%2Fb', '/a/%2Fb'],
    ['/a/%09b', '/a/%09b'],
    ['/a/b\\c', '/a/b/c'],
    ['/%252F/x', '/%252F/x'],
    ['/é', '/%C3%A9'],
    ['/?q=a b', '/?q=a%20b'],
  ],
  rejected: [
    // A second slash or a backslash after the leading slash parses as an authority.
    '//evil.example/daily',
    '/\\evil.example/daily',
    '/\\ x',
    '/\\mpgd.invalid/daily',
    '/\\user:pw@mpgd.invalid:443/daily',
    // Control characters; URL parsing would drop the tab or newline.
    '/\t/evil.example/daily',
    '/\n/mpgd.invalid/daily',
    '/daily\u0000',
    '/daily\u007f',
    // Dot segments collapse into a leading `//`.
    '/.//evil.example/daily',
    '/levels/..//evil.example/daily',
    '/%2e//evil.example/daily',
    '/%2E%2E//evil.example/daily',
    '/./\\evil.example/daily',
    // One percent-decode turns these into the shapes above.
    '/%2F%2Fevil.example/daily',
    '/%5cevil.example/daily',
    '/%09/evil.example/daily',
    '/%0A%0d/evil.example/daily',
    '/%09%5Cevil.example/daily',
    '/%09.//evil.example/daily',
    '/.%2F/evil.example/daily',
    '/levels/..%2F%2Fevil.example/daily',
    // A double-encoded dot segment resolves after one decode.
    '/%252e%252e//evil.example/daily',
  ],
  notRootRelative: ['', 'daily', './daily', '?q=1', 'https://game.example/daily', '\\\\evil.example/daily'],
  onOriginPaths: ['/', '/daily', '/levels//3', '/a/%2Fb', '/a/%09b', '/%252F/x'],
  networkPaths: ['//evil.example', '/%2F/evil.example', '/%5Cevil.example', '/%09/evil.example', '/.%2F/evil.example', '/%2e%2e%2f%2fevil.example'],
  canonical: ['/', '/daily', '/?entry=continue', '/events/weekend', '/settings/notifications', '/levels//3', '/a/%2Fb', '/%C3%A9'],
  notCanonical: [
    // Normalization would change these.
    '/levels/../daily',
    '/a/./b',
    '/é',
    '/a b',
    // Backslashes and control characters anywhere.
    '/?q=\\',
    '/a\\b',
    '/daily\t',
    // Once decoded, the path hides a backslash, a control character, a network path, or a dot segment.
    '/%5Cdaily',
    '/a/%09b',
    '/%2Fdaily',
    '/a/%252e/b',
    // Not decodable, too long, or not root-relative.
    '/%E0%A4%A',
    `/${'a'.repeat(2_048)}`,
    'daily',
  ],
};
