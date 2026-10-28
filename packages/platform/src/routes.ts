import type { ShareAdapter, ShareIntent, ShareResult } from './index.js';

/**
 * Route safety for links a game hands to the kit, such as notification deep
 * links and share links. A URL parser treats `\` as `/`, drops tabs and
 * newlines, and resolves dot segments, and some clients percent-decode a path
 * once before routing it. Any of these can turn a root-relative link into a
 * protocol-relative one (`//evil.example/x`) that a client opens on another
 * host.
 */

/** Collapse HTTP(S) path segments without requiring the DOM URL global. */
function normalizePath(path: string): string {
  const segments = path.replace(/\\/gu, '/').slice(1).split('/');
  const result: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const dot = segment.replace(/%2e/giu, '.');
    if (dot === '.' || dot === '..') {
      if (dot === '..') {
        result.pop();
      }
      if (index === segments.length - 1) {
        result.push('');
      }
    } else {
      result.push(segment);
    }
  }
  return `/${result.join('/')}`;
}

/** WHATWG HTTP(S) component encoding; existing percent escapes stay intact. */
function encodeRouteComponent(value: string, component: 'path' | 'query' | 'hash'): string {
  const extra = component === 'path' ? ' "#<>?^`{}' : component === 'query' ? ' "#<>\'' : ' "<>`';
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x7e || code <= 0x20 || extra.includes(character)) {
      const scalar = code >= 0xd800 && code <= 0xdfff ? '\uFFFD' : character;
      // encodeURIComponent leaves an apostrophe unescaped, unlike a special query.
      result += character === "'" ? '%27' : encodeURIComponent(scalar);
    } else {
      result += character;
    }
  }
  return result;
}

/** Whether `value` contains an ASCII control character (C0 or DEL). */
export function hasRouteControlCharacter(value: string): boolean {
  return /[\x00-\x1F\x7F]/u.test(value);
}

/**
 * The most decoded `?` and `#` a path may carry. Each one is a reading
 * `hasNetworkPathPrefix` parses, so a path with more is refused instead.
 */
const maxPathDelimiters = 16;

/**
 * Whether a normalized URL path could be read as a network-path reference to
 * another host. Dot segments (also percent-encoded) can collapse `/.//host`
 * into `//host`. A consumer that percent-decodes the path once and parses it
 * again can reach the same shape from `/%2F/host`, `/%5Chost`, `/%09/host`,
 * or `/.%2F/host`: URL parsing drops tabs and newlines, reads a backslash as a
 * slash, and removes dot segments, so the decoded path is checked after the
 * same steps. A consumer may also end the decoded path at any `?` or `#`, or
 * keep them all in it, so each of those readings is checked:
 * `/.%2F%2Fhost%3F%2F..%2F..` reaches `//host` when the path ends at the `?`,
 * and `/%3F%2F..%2F%2Fhost` when it keeps it. A path with more than 16
 * decoded `?` and `#` is answered `true`. `pathname` is a URL's path (it
 * starts with `/`); anything else is answered `true`, so a caller fails
 * closed.
 */
export function hasNetworkPathPrefix(pathname: string): boolean {
  if (!pathname.startsWith('/')) {
    return true;
  }

  const decoded = pathname
    .replace(/%([0-7][0-9a-f])/giu, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/[\t\n\r]/gu, '');

  if (/^[/\\]{2}/u.test(decoded)) {
    return true;
  }

  const delimiters: number[] = [];

  for (const match of decoded.matchAll(/[?#]/gu)) {
    if (delimiters.length === maxPathDelimiters) {
      return true;
    }

    delimiters.push(match.index);
  }

  // Each reading is a prefix of the decoded path, so it starts with one slash
  // and no second slash or backslash: parsing it cannot fail or reach another
  // origin. A `?` or `#` left in a reading is escaped so it stays in the path,
  // and the path-only normalizer keeps trailing spaces and controls, as when
  // the rest of the link follows, instead of stripping them as URL input.
  return [...delimiters, decoded.length].some((end) => {
    const reading = decoded
      .slice(0, end)
      .replace(/[?#]/gu, (delimiter) => (delimiter === '?' ? '%3F' : '%23'));

    return normalizePath(reading).startsWith('//');
  });
}

/**
 * Normalizes a root-relative link to the `pathname`, `search`, and `hash` it
 * names on the game's own origin, or answers `undefined` when a client could
 * read it as another host: a second slash or a backslash right after the
 * leading slash (`//host`, `/\host`), a control character, or a path whose
 * normalized form begins with an empty segment, also once percent-decoded
 * (see `hasNetworkPathPrefix`, which also refuses a path with more than 16
 * percent-encoded `?` and `#`, `%3F` and `%23`).
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

  // Match the HTTP(S) URL path algorithm with string operations so pure
  // notification/catalog validation also works in runtimes with no URL.
  const trimmed = input.replace(/ +$/u, '');
  const hashIndex = trimmed.indexOf('#');
  const beforeHash = hashIndex < 0 ? trimmed : trimmed.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf('?');
  const path = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : beforeHash.slice(queryIndex + 1);
  const fragment = hashIndex < 0 ? '' : trimmed.slice(hashIndex + 1);
  const pathname = encodeRouteComponent(normalizePath(path), 'path');
  const search = query === '' ? '' : `?${encodeRouteComponent(query, 'query')}`;
  const hash = fragment === '' ? '' : `#${encodeRouteComponent(fragment, 'hash')}`;

  return hasNetworkPathPrefix(pathname) ? undefined : `${pathname}${search}${hash}`;
}

/**
 * Whether `value` is a clean same-origin game-services ingress path: `/api`
 * or `/api/` followed by segments of `A-Z a-z 0-9 _ -`, with an optional
 * trailing slash, and no surrounding whitespace. Anything a URL parser could
 * read as another host or rewrite is refused: `//host`, backslashes, dot
 * segments, percent-encoding, whitespace, query, and fragment. Hosted web
 * builds (the CLI's production readiness check) and the browser composition
 * (`resolveGameServicesBaseUrl` in `@mpgd/game-services`) share this one rule.
 */
export function isHostedGameServicesPath(value: string): boolean {
  return value === value.trim() && /^\/api(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(value);
}

/**
 * Normalizes a `ShareIntent.deepLink`, or answers `undefined` for a link
 * outside its contract. A root-relative link becomes the route
 * `normalizeRootRelativeRoute` returns. An absolute link must spell out
 * `https://` or `http://`, carry no credentials, and keep a path no client
 * can read as another host; it comes back serialized. Anything else is
 * refused: a page-relative link (`./daily`, `?x=1`), another scheme
 * (`javascript:`, `intoss:`), and any link with a control character.
 */
export function normalizeShareLink(deepLink: string): string | undefined {
  if (hasRouteControlCharacter(deepLink)) {
    return undefined;
  }

  if (deepLink.startsWith('/')) {
    return normalizeRootRelativeRoute(deepLink);
  }

  // `https:/daily` and `https:host/x` parse as absolute links to another host
  // without a base but resolve on the page with one, so only the full form counts.
  if (!/^https?:\/\//iu.test(deepLink)) {
    return undefined;
  }

  let parsed: URL;

  try {
    parsed = new URL(deepLink);
  } catch {
    return undefined;
  }

  return parsed.username === ''
    && parsed.password === ''
    && !hasNetworkPathPrefix(parsed.pathname)
    ? parsed.href
    : undefined;
}

/**
 * Reads a `share` intent under the `ShareIntent` contract: the intent with its
 * `deepLink` normalized by `normalizeShareLink`, or `undefined` when it is not
 * an object, its kind is unsupported, its title or text is not a string, or
 * its `deepLink` is not a link that
 * rule accepts. The intent may come from untyped game code, so none of this
 * is assumed.
 */
export function readShareIntent(intent: unknown): ShareIntent | undefined {
  if (typeof intent !== 'object' || intent === null || Array.isArray(intent)) {
    return undefined;
  }

  const { kind, title, text, deepLink } = intent as Readonly<Record<string, unknown>>;
  const link = typeof deepLink === 'string' ? normalizeShareLink(deepLink) : undefined;

  return (kind === 'daily-result' || kind === 'friend-challenge' || kind === 'invite')
    && typeof title === 'string' && typeof text === 'string' && link !== undefined
    ? { ...(intent as ShareIntent), kind, title, text, deepLink: link }
    : undefined;
}

/**
 * Puts `readShareIntent` in front of an adapter's `share`: the adapter and its
 * host see only intents the contract accepts, with the link normalized, and
 * any other intent answers `unavailable` without reaching them. Every other
 * member is kept as is. Adapters wrap their `sharing` with it, and their tests
 * run `@mpgd/platform/share-link-conformance`.
 */
export function withShareIntentCheck(sharing: ShareAdapter): ShareAdapter {
  const share = sharing.share?.bind(sharing);
  const readInboundShare = sharing.readInboundShare?.bind(sharing);
  const checkedShare = share === undefined
    ? undefined
    : async (intent: ShareIntent): Promise<ShareResult> => {
        const checked = readShareIntent(intent);

        return checked === undefined ? { status: 'unavailable' } : share(checked);
      };

  // The bound methods also cover an adapter whose methods live on a prototype,
  // which the spread does not copy.
  return {
    ...sharing,
    ...(checkedShare === undefined ? {} : { share: checkedShare }),
    ...(readInboundShare === undefined ? {} : { readInboundShare }),
  };
}
