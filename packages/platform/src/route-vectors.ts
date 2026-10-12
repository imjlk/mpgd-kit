/**
 * Shared vectors for `@mpgd/platform/routes`. Every package that turns a
 * game-supplied root-relative link into a path on the game or mini-app origin
 * runs these, so a new escape is added here once and caught everywhere.
 */
export interface RootRelativeRouteVectors {
  /** Root-relative inputs `normalizeRootRelativeRoute` accepts, with the route it returns. */
  readonly normalized: readonly (readonly [input: string, route: string])[];
  /** Root-relative inputs a client could read as another host: `normalizeRootRelativeRoute` answers `undefined`. */
  readonly rejected: readonly string[];
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
    ['/search%3Fq', '/search%3Fq'],
    ['/é', '/%C3%A9'],
    ['/?q=a b', '/?q=a%20b'],
  ],
  rejected: [
    // A second slash or a backslash after the leading slash parses as an authority.
    '//evil.example/daily',
    '/\\evil.example/daily',
    '/\\ x',
    '/\\ evil.example/daily',
    '/\\mpgd.invalid/daily',
    '/\\mpgd.invalid//evil.example/daily',
    '/\\user:pw@mpgd.invalid:443/daily',
    // Control characters; URL parsing would drop the tab or newline.
    '/\t/ x',
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
    // A decoded `?` or `#` stays in the path a client routes, so dot segments after it still collapse.
    '/%3F%2F..%2F%2Fevil.example/daily',
    '/%23%2F..%2F%2Fevil.example/daily',
  ],
};
