import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

const ownerPathByTarget = {
  ait: 'wrapperApp',
  android: 'shellApp',
  ios: 'shellApp',
} as const;

export interface ProductionTargetReadinessInput {
  readonly target: string;
  readonly profile: string;
  readonly targetsFile: string;
  readonly gameRoot: string;
  readonly gameServicesUrl?: string;
}

export function assertProductionTargetReadiness(
  input: ProductionTargetReadinessInput,
): void {
  if (
    typeof input.profile !== 'string'
    || input.profile.length === 0
    || input.profile.trim() !== input.profile
  ) {
    throw new Error(
      'Target build profile must be a non-empty string without surrounding whitespace.',
    );
  }

  if (input.profile !== 'production') {
    return;
  }

  const ownerPathKey = ownerPathByTarget[input.target as keyof typeof ownerPathByTarget];

  if (ownerPathKey === undefined) {
    return;
  }

  const targetConfig = readTargets(input.targetsFile)[input.target];

  if (!isRecord(targetConfig)) {
    throw new Error(`Missing target configuration for ${input.target}.`);
  }

  const ownerPath = targetConfig[ownerPathKey];
  const webDir = targetConfig.webDir;

  if (typeof ownerPath !== 'string' || ownerPath.length === 0) {
    throw new Error(`Production target ${input.target} is missing ${ownerPathKey}.`);
  }

  if (typeof webDir !== 'string' || webDir.length === 0) {
    throw new Error(`Production target ${input.target} is missing webDir.`);
  }

  const resolvedOwnerPath = path.resolve(path.dirname(input.targetsFile), ownerPath);
  const resolvedWebDir = path.resolve(path.dirname(input.targetsFile), webDir);
  const canonicalGameRoot = readCanonicalPath(input.gameRoot, 'game root');
  const canonicalOwnerPath = readCanonicalPath(
    resolvedOwnerPath,
    `${input.target} ${ownerPathKey}`,
  );

  if (!isDedicatedChildPath(canonicalGameRoot, canonicalOwnerPath)) {
    throw new Error(
      `Production target ${input.target} must use a game-owned ${ownerPathKey} inside `
        + `${canonicalGameRoot}; received ${canonicalOwnerPath}. `
        + 'Use a non-production profile for kit reference wrapper/shell smoke builds.',
    );
  }

  const canonicalWebDir = readCanonicalPathAllowingMissingTail(
    resolvedWebDir,
    `${input.target} webDir`,
  );

  if (!isDedicatedChildPath(canonicalOwnerPath, canonicalWebDir)) {
    throw new Error(
      `Production target ${input.target} must keep webDir inside its game-owned `
        + `${ownerPathKey} ${canonicalOwnerPath}; received ${canonicalWebDir}.`,
    );
  }

  if (input.target === 'android' || input.target === 'ios') {
    const canonicalPlatformDir = readCanonicalPathAllowingMissingTail(
      path.join(resolvedOwnerPath, input.target),
      `${input.target} native platform directory`,
    );

    if (!isDedicatedChildPath(canonicalOwnerPath, canonicalPlatformDir)) {
      throw new Error(
        `Production target ${input.target} must keep its native platform directory inside `
          + `${canonicalOwnerPath}; received ${canonicalPlatformDir}.`,
      );
    }
  }

  if (targetConfig.authoritativeGameServices !== false) {
    assertAuthoritativeGameServicesUrl(input.gameServicesUrl, input.target);
  }
}

function readTargets(targetsFile: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(targetsFile, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Failed to read prepared targets file ${targetsFile}: ${formatError(error)}`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.targets)) {
    throw new Error(`Prepared targets file ${targetsFile} must contain a targets object.`);
  }

  return parsed.targets;
}

// Equality is rejected: a wrapper or shell must be a dedicated child of the game root.
function isDedicatedChildPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);

  return relative.length > 0
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function readCanonicalPath(candidate: string, label: string): string {
  try {
    return realpathSync(candidate);
  } catch (error) {
    throw new Error(`Production ${label} must exist: ${candidate} (${formatError(error)})`);
  }
}

function readCanonicalPathAllowingMissingTail(candidate: string, label: string): string {
  let existingPath = candidate;
  const missingSegments: string[] = [];

  while (!existsSync(existingPath)) {
    const parent = path.dirname(existingPath);

    if (parent === existingPath) {
      throw new Error(`Production ${label} has no existing ancestor: ${candidate}`);
    }

    missingSegments.unshift(path.basename(existingPath));
    existingPath = parent;
  }

  return path.join(readCanonicalPath(existingPath, label), ...missingSegments);
}

function assertAuthoritativeGameServicesUrl(
  value: string | undefined,
  target: string,
): void {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Production target ${target} requires VITE_MPGD_GAME_SERVICES_URL for an `
        + 'authoritative remote backend.',
    );
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Production target ${target} has an invalid game-services URL.`);
  }

  if (
    url.protocol !== 'https:'
    || url.username.length > 0
    || url.password.length > 0
    || isNonPublicServiceHostname(url.hostname)
  ) {
    throw new Error(
      `Production target ${target} requires a public HTTPS game-services URL `
        + 'without embedded credentials.',
    );
  }
}

function isNonPublicServiceHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/u, '');

  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
  ) {
    return true;
  }

  const ipVersion = isIP(normalized);

  if (ipVersion === 4) {
    return isNonPublicIpv4(normalized);
  }

  if (ipVersion === 6) {
    return isNonPublicIpv6(normalized);
  }

  return false;
}

function isNonPublicIpv4(address: string): boolean {
  const [first = 0, second = 0, third = 0] = address.split('.').map(Number);

  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function isNonPublicIpv6(address: string): boolean {
  const words = expandIpv6(address);

  if (words === undefined) {
    return true;
  }

  if (words.slice(0, 7).every((word) => word === 0)) {
    return true;
  }

  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isNonPublicIpv4(
      `${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 0xff}.`
        + `${(words[7] ?? 0) >> 8}.${(words[7] ?? 0) & 0xff}`,
    );
  }

  if (words.slice(0, 6).every((word) => word === 0)) {
    return isNonPublicIpv4(
      `${(words[6] ?? 0) >> 8}.${(words[6] ?? 0) & 0xff}.`
        + `${(words[7] ?? 0) >> 8}.${(words[7] ?? 0) & 0xff}`,
    );
  }

  const first = words[0] ?? 0;

  return (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && words[1] === 0x0db8);
}

function expandIpv6(address: string): readonly number[] | undefined {
  const sections = address.split('::');

  if (sections.length > 2) {
    return undefined;
  }

  const head = ipv6Words(sections[0] ?? '');
  const tail = ipv6Words(sections[1] ?? '');

  if (head === undefined || tail === undefined) {
    return undefined;
  }

  const omitted = 8 - head.length - tail.length;

  if ((sections.length === 1 && omitted !== 0) || (sections.length === 2 && omitted < 1)) {
    return undefined;
  }

  return [...head, ...Array.from({ length: omitted }, () => 0), ...tail];
}

function ipv6Words(section: string): readonly number[] | undefined {
  if (section.length === 0) {
    return [];
  }

  const words: number[] = [];

  for (const segment of section.split(':')) {
    if (!/^[0-9a-f]{1,4}$/u.test(segment)) {
      return undefined;
    }

    words.push(Number.parseInt(segment, 16));
  }

  return words;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
