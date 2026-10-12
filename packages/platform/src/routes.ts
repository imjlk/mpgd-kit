/**
 * Route safety for links a game hands to the kit, such as notification deep
 * links and share links. A URL parser treats `\` as `/`, drops tabs and
 * newlines, and resolves dot segments, and some clients percent-decode a path
 * once before routing it. Any of these can turn a root-relative link into a
 * protocol-relative one (`//evil.example/x`) that a client opens on another
 * host.
 */

const placeholderOrigin = 'https://mpgd.invalid';

/** Whether `value` contains an ASCII control character (C0 or DEL). */
export function hasRouteControlCharacter(value: string): boolean {
  return /[\x00-\x1F\x7F]/u.test(value);
}

/**
 * Whether a normalized URL path could be read as a network-path reference to
 * another host. Dot segments (also percent-encoded) can collapse `/.//host`
 * into `//host`. A consumer that percent-decodes the path once and parses it
 * again as a path can reach the same shape from `/%2F/host`, `/%5Chost`,
 * `/%09/host`, `/.%2F/host`, or `/%3F%2F..%2F%2Fhost`: URL parsing drops tabs
 * and newlines, reads a backslash as a slash, and removes dot segments, so
 * the decoded path is checked after the same steps, with a decoded `?` or `#`
 * kept in the path. `pathname` is a URL's path (it starts with `/`); anything
 * else is answered `true`, so a caller fails closed.
 */
export function hasNetworkPathPrefix(pathname: string): boolean {
  if (!pathname.startsWith('/')) {
    return true;
  }

  const decoded = pathname
    .replace(/%([0-7][0-9a-f])/giu, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/[\t\n\r]/gu, '')
    // The decoded string is a path: a `?` or `#` in it does not start a query
    // or fragment for a client that routes the path.
    .replace(/[?#]/gu, (delimiter) => (delimiter === '?' ? '%3F' : '%23'));

  // A decoded path that does not start with two slashes is a plain path, so
  // parsing it cannot fail or reach another origin.
  return /^[/\\]{2}/u.test(decoded)
    || new URL(decoded, placeholderOrigin).pathname.startsWith('//');
}

/**
 * Normalizes a root-relative link to the `pathname`, `search`, and `hash` it
 * names on the game's own origin, or answers `undefined` when a client could
 * read it as another host: a second slash or a backslash right after the
 * leading slash (`//host`, `/\host`), a control character, or a path whose
 * normalized form begins with an empty segment (see `hasNetworkPathPrefix`).
 * Dot segments that stay on the origin resolve (`/levels/../daily` is
 * `/daily`), and a normalized route normalizes to itself. The result is not
 * length-capped, because percent-encoding can grow it; callers apply their
 * own limits.
 */
export function normalizeRootRelativeRoute(input: string): string | undefined {
  if (
    !input.startsWith('/')
    || input.startsWith('//')
    || input.startsWith('/\\')
    || hasRouteControlCharacter(input)
  ) {
    return undefined;
  }

  // With no control character and no second slash or backslash, the input is
  // a plain path: it cannot fail to parse or reach another origin.
  const { pathname, search, hash } = new URL(input, placeholderOrigin);

  return hasNetworkPathPrefix(pathname) ? undefined : `${pathname}${search}${hash}`;
}
