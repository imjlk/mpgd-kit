/**
 * Parsing and evaluation for the Cloudflare Pages `_headers` and `_redirects`
 * static configuration files.
 *
 * The supported syntax subset follows the official Pages documentation: path
 * blocks with indented directives, `!` removal lines, single-splat and
 * placeholder patterns, `#` comments, and CRLF or LF line endings. Constructs
 * outside that subset produce explicit unsupported diagnostics instead of
 * being silently ignored.
 */

export interface CloudflarePagesHeaderAddDirective {
  readonly kind: 'add';
  readonly name: string;
  readonly value: string;
}

export interface CloudflarePagesHeaderRemoveDirective {
  readonly kind: 'remove';
  readonly name: string;
}

export type CloudflarePagesHeaderDirective =
  | CloudflarePagesHeaderAddDirective
  | CloudflarePagesHeaderRemoveDirective;

export interface CloudflarePagesHeaderBlock {
  readonly path: string;
  readonly directives: readonly CloudflarePagesHeaderDirective[];
}

export interface CloudflarePagesRedirectRule {
  readonly source: string;
  readonly destination: string;
  readonly code: number | undefined;
}

export interface EffectiveHeaderResult {
  /** Final value the sequential Cloudflare evaluation model produces. */
  readonly value: string | undefined;
  /** Values added by matching blocks, in file order. */
  readonly additions: readonly string[];
  /** True when a matching block removed the header. */
  readonly removed: boolean;
}

const maximumHeaderBlocks = 100;
const maximumLineLength = 2_000;
const supportedRedirectCodes = new Set([301, 302, 303, 307, 308]);

export function parseCloudflarePagesHeaders(input: string): readonly CloudflarePagesHeaderBlock[] {
  const lines = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const blocks: CloudflarePagesHeaderBlock[] = [];

  for (const line of lines) {
    if (line.length > maximumLineLength) {
      throw new Error(
        `Cloudflare Pages _headers line exceeds the ${maximumLineLength}-character limit.`,
      );
    }
  }

  let currentPath: string | undefined;
  let currentDirectives: CloudflarePagesHeaderDirective[] = [];

  const flushBlock = (): void => {
    if (currentPath !== undefined && currentDirectives.length > 0) {
      blocks.push({ path: currentPath, directives: currentDirectives });
    }
    currentPath = undefined;
    currentDirectives = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const indented = /^[ \t]/u.test(line);

    if (!indented) {
      flushBlock();
      assertSupportedHeaderPathPattern(trimmed);
      assertSupportedPlaceholderShape(trimmed);
      currentPath = trimmed;
      continue;
    }

    if (currentPath === undefined) {
      throw new Error(
        `Cloudflare Pages _headers directive appears before any path block: ${trimmed}`,
      );
    }

    currentDirectives.push(parseHeaderDirective(trimmed));
  }

  flushBlock();

  if (blocks.length > maximumHeaderBlocks) {
    throw new Error(
      `Cloudflare Pages _headers declares ${blocks.length} blocks; `
        + `the documented limit is ${maximumHeaderBlocks}.`,
    );
  }

  return blocks;
}

export function parseCloudflarePagesRedirects(
  input: string,
): readonly CloudflarePagesRedirectRule[] {
  const lines = input.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const rules: CloudflarePagesRedirectRule[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split(/\s+/u);

    if (parts.length < 2 || parts.length > 3 || parts.some((part) => part.length === 0)) {
      throw new Error(`Cloudflare Pages _redirects line is malformed: ${trimmed}`);
    }

    const [source, destination, codeText] = parts as [string, string, string | undefined];
    assertSupportedRedirectPattern(source, destination);
    assertSupportedPlaceholderShape(source);

    let code: number | undefined;

    if (codeText !== undefined) {
      const parsed = /^\d{3}$/u.exec(codeText);

      if (parsed === null || !supportedRedirectCodes.has(Number(codeText))) {
        throw new Error(`Cloudflare Pages _redirects status code is unsupported: ${codeText}`);
      }

      code = Number(codeText);
    }

    rules.push({ source, destination, code });
  }

  return rules;
}

/**
 * Evaluate the effective header for a request path. Cloudflare applies every
 * matching block in file order: `name: value` lines accumulate (duplicate
 * headers are joined with commas by the platform) and `! name` lines remove
 * everything accumulated for that header so far.
 */
export function evaluateCloudflarePagesHeader(
  blocks: readonly CloudflarePagesHeaderBlock[],
  requestPath: string,
  headerName: string,
): EffectiveHeaderResult {
  const normalizedHeader = headerName.toLowerCase();
  const additions: string[] = [];
  let removed = false;

  for (const block of blocks) {
    if (!cloudflarePagesPathMatches(block.path, requestPath)) {
      continue;
    }

    for (const directive of block.directives) {
      if (directive.name.toLowerCase() !== normalizedHeader) {
        continue;
      }

      if (directive.kind === 'remove') {
        additions.length = 0;
        removed = true;
      } else {
        additions.push(directive.value);
      }
    }
  }

  return {
    value: additions.length === 0 ? undefined : additions.join(', '),
    additions: [...additions],
    removed,
  };
}

/**
 * Normalize a comma-separated directive value for semantic comparison:
 * whitespace-trimmed, lower-cased, empty segments dropped, order-insensitive.
 */
export function normalizeHeaderDirectiveValue(value: string): string {
  return value
    .split(',')
    .map((directive) => directive.trim().toLowerCase())
    .filter((directive) => directive.length > 0)
    .sort()
    .join(', ');
}

/** Match a supported `_headers` path pattern against a request path. */
export function cloudflarePagesPathMatches(pattern: string, requestPath: string): boolean {
  // Segments are compared without dropping empties: '/x/' and '/x' are
  // distinct request paths, and only the root '/' is the empty pair.
  const patternParts = pattern.split('/');
  const pathParts = requestPath.split('/');

  if (patternParts[0] === '' && pathParts[0] === '') {
    return matchesFrom(patternParts.slice(1), pathParts.slice(1));
  }

  return false;
}

function matchesFrom(patternParts: readonly string[], pathParts: readonly string[]): boolean {
  if (patternParts.length === 0) {
    return pathParts.length === 0;
  }

  const [firstPart, ...rest] = patternParts;
  const head = firstPart ?? '';

  if (head === '*') {
    // A standalone splat carries its preceding slash, so it must consume at
    // least one segment: /service-worker.js/* does not match /service-worker.js.
    for (let skip = 1; skip <= pathParts.length; skip += 1) {
      if (matchesFrom(rest, pathParts.slice(skip))) {
        return true;
      }
    }

    return false;
  }

  if (pathParts.length === 0) {
    return false;
  }

  if (!partMatches(head, pathParts[0] ?? '')) {
    return false;
  }

  return matchesFrom(rest, pathParts.slice(1));
}

function partMatches(pattern: string, value: string): boolean {
  if (!pattern.includes(':') && !pattern.includes('*')) {
    return pattern === value;
  }

  assertSupportedPlaceholderShape(pattern);

  // Placeholders match one non-separator run; a splat is greedy inside its
  // segment, so /assets/*.js covers /assets/app.js like the Pages router.
  const placeholderJoined = pattern
    .split(/:[A-Za-z]\w*/gu)
    .map(escapeRegExp)
    .join('[^/]+');

  return new RegExp(`^${placeholderJoined.replaceAll('*', '.*')}$`, 'u').test(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/gu, '\\$&');
}

/** Reject placeholder shapes that would compile into ambiguous backtracking. */
function assertSupportedPlaceholderShape(path: string): void {
  for (const segment of path.split('/')) {
    const placeholders = [...segment.matchAll(/:[A-Za-z]\w*/gu)];

    if (placeholders.length > 1) {
      throw new Error(
        'Cloudflare Pages path segments must contain at most one placeholder: '
          + `${path} (${segment})`,
      );
    }
  }
}

function assertSupportedHeaderPathPattern(path: string): void {
  if (/^https?:\/\//iu.test(path)) {
    throw new Error(`Cloudflare Pages _headers absolute-URL patterns are unsupported: ${path}`);
  }

  if (!path.startsWith('/')) {
    throw new Error(`Cloudflare Pages _headers path must start with '/': ${path}`);
  }

  const splatCount = [...path.matchAll(/\*/gu)].length;

  if (splatCount > 1) {
    throw new Error(`Cloudflare Pages _headers supports at most one splat per pattern: ${path}`);
  }
}

function assertSupportedRedirectPattern(source: string, destination: string): void {
  if (!source.startsWith('/')) {
    throw new Error(`Cloudflare Pages _redirects source must start with '/': ${source}`);
  }

  if ([...source.matchAll(/\*/gu)].length > 1) {
    throw new Error(`Cloudflare Pages _redirects supports at most one splat per source: ${source}`);
  }

  if (/^https?:\/\//iu.test(destination) && destination.includes(':splat')) {
    throw new Error(
      'Cloudflare Pages _redirects :splat interpolation into absolute URLs is unsupported.',
    );
  }
}

function parseHeaderDirective(line: string): CloudflarePagesHeaderDirective {
  if (line.startsWith('!')) {
    const name = line.slice(1).trim();

    if (!/^[A-Za-z0-9-]+$/u.test(name)) {
      throw new Error(`Cloudflare Pages _headers removal directive is malformed: ${line}`);
    }

    return { kind: 'remove', name };
  }

  const separator = line.indexOf(':');

  if (separator <= 0) {
    throw new Error(`Cloudflare Pages _headers directive is malformed: ${line}`);
  }

  const name = line.slice(0, separator).trim();

  if (!/^[A-Za-z0-9-]+$/u.test(name)) {
    throw new Error(`Cloudflare Pages _headers directive name is malformed: ${line}`);
  }

  const value = line.slice(separator + 1).trim();

  if (value.length === 0) {
    throw new Error(`Cloudflare Pages _headers directive value is empty: ${line}`);
  }

  if (value.includes(':splat')) {
    throw new Error(`Cloudflare Pages _headers :splat interpolation is unsupported: ${line}`);
  }

  return { kind: 'add', name, value };
}
