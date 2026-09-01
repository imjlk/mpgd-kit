import { MiniGameRuntimeError } from './host.js';

export interface ParsedMiniGameHttpsUrl {
  readonly origin: string;
  readonly href: string;
  readonly pathAndQuery: string;
  readonly hadFragment: boolean;
}

export function parseMiniGameHttpsUrl(
  value: string,
  invalidCode: string,
  invalidMessage: string,
  credentialsCode: string,
): ParsedMiniGameHttpsUrl {
  const match = /^[Hh][Tt][Tt][Pp][Ss]:\/\/([^/?#]+)(.*)$/u.exec(value);

  if (match === null) {
    throw new MiniGameRuntimeError(invalidCode, `${invalidMessage}: ${value}`);
  }

  const authority = match[1] ?? '';
  let suffix = match[2] ?? '';

  if (authority.includes('@')) {
    throw new MiniGameRuntimeError(
      credentialsCode,
      'Mini-game HTTPS URLs must not contain embedded credentials.',
    );
  }

  const authorityMatch = /^([A-Za-z\d](?:[A-Za-z\d.-]*[A-Za-z\d])?)(?::(\d{1,5}))?$/u.exec(
    authority,
  );

  if (authorityMatch === null) {
    throw new MiniGameRuntimeError(invalidCode, `${invalidMessage}: ${value}`);
  }

  const hostname = (authorityMatch[1] ?? '').toLowerCase();
  const portText = authorityMatch[2];

  if (!isValidHostname(hostname)) {
    throw new MiniGameRuntimeError(invalidCode, `${invalidMessage}: ${value}`);
  }

  let normalizedPort = '';

  if (portText !== undefined) {
    const port = Number(portText);

    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new MiniGameRuntimeError(invalidCode, `${invalidMessage}: ${value}`);
    }

    if (port !== 443) {
      normalizedPort = `:${port}`;
    }
  }

  if (/[^\u0021-\u007e]/u.test(suffix) || suffix.includes('\\')) {
    throw new MiniGameRuntimeError(invalidCode, `${invalidMessage}: ${value}`);
  }

  const fragmentIndex = suffix.indexOf('#');
  const hadFragment = fragmentIndex >= 0;

  if (hadFragment) {
    suffix = suffix.slice(0, fragmentIndex);
  }

  if (suffix.startsWith('?')) {
    suffix = `/${suffix}`;
  }

  const origin = `https://${hostname}${normalizedPort}`;

  return {
    origin,
    href: `${origin}${suffix.length === 0 ? '/' : suffix}`,
    pathAndQuery: suffix,
    hadFragment,
  };
}

export function normalizeMiniGameHttpsOrigin(value: string): string {
  const parsed = parseMiniGameHttpsUrl(
    value,
    'MINIGAME_INVALID_REMOTE_ORIGIN',
    'Allowed mini-game remote origins must be exact ASCII HTTPS origins',
    'MINIGAME_INVALID_REMOTE_ORIGIN',
  );

  if (parsed.hadFragment || (parsed.pathAndQuery !== '' && parsed.pathAndQuery !== '/')) {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_REMOTE_ORIGIN',
      `Allowed mini-game remote origins must not include a path, query, or fragment: ${value}`,
    );
  }

  return parsed.origin;
}

function isValidHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253 || hostname.includes('..')) {
    return false;
  }

  return hostname.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
  ));
}
