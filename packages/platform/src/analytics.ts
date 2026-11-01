/**
 * Platform analytics sink (`@mpgd/platform/analytics`).
 *
 * Some hosts chart their own analytics: the Apps in Toss console builds event
 * and key/conversion metrics only from logs the mini-app sends through its SDK.
 * A `PlatformAnalyticsSink` hands a game's bounded, already-sanitized logs to
 * that host analytics. It mirrors product moments; the game's first-party
 * analytics pipeline (`@mpgd/analytics`, game-services) stays the source of
 * truth, and nothing here may grant, rank, or verify anything.
 *
 * A log carries a name, a type, and at most eight flat primitive parameters.
 * It must not carry account ids, player ids, room ids, scores, or anything else
 * that identifies a player or a session. `readPlatformAnalyticsLog` enforces
 * the shape and refuses parameter names and values that look like identifiers,
 * but it cannot recognise every identifier: the game chooses what it sends.
 *
 * Everything here is SDK-free and DOM-free; adapters implement the sink, and a
 * host re-validates every log with `readPlatformAnalyticsLog` before it calls
 * its SDK.
 */

/**
 * `screen`: the player entered a screen. `event`: a product moment (a run
 * finished, an invite was sent). `click` and `impression`: an element was
 * touched or shown.
 */
export type PlatformAnalyticsLogType = 'screen' | 'event' | 'click' | 'impression';

export const platformAnalyticsLogTypes: readonly PlatformAnalyticsLogType[] = Object.freeze([
  'screen',
  'event',
  'click',
  'impression',
]);

export type PlatformAnalyticsParamValue = string | number | boolean;

export type PlatformAnalyticsParams = Readonly<Record<string, PlatformAnalyticsParamValue>>;

export interface PlatformAnalyticsLog {
  /** Lowercase snake_case, 2 to 64 characters, starting with a letter: `nem_play_start`. */
  readonly logName: string;
  readonly logType: PlatformAnalyticsLogType;
  /** At most `platformAnalyticsParamLimit` flat primitive values; defaults to none. */
  readonly params?: PlatformAnalyticsParams;
}

/**
 * `available`: the host sends the log types listed in `logTypes`.
 * `unsupported`: the target has no platform analytics, or the host does not
 * offer it; every log is dropped.
 */
export type PlatformAnalyticsState = 'available' | 'unsupported';

export interface PlatformAnalyticsStatus {
  /** The host analytics, for example `apps-in-toss`; `none` when there is none. */
  readonly provider: string;
  readonly state: PlatformAnalyticsState;
  /**
   * The log types this host sends now; empty when `unsupported`. A host may
   * send only some types, for example an Apps in Toss app older than 5.208.0
   * sends `screen`, `click`, and `impression` but no `event`.
   */
  readonly logTypes: readonly PlatformAnalyticsLogType[];
}

/**
 * Platform analytics as games see it (`PlatformGateway.analytics`). Every
 * method resolves; a sink never throws into game code, so a game may call
 * `void gateway.analytics?.log(...)` and continue. An unsupported target makes
 * every call a no-op.
 */
export interface PlatformAnalyticsSink {
  getStatus(): Promise<PlatformAnalyticsStatus>;
  /**
   * Hand one log to the host analytics. Resolves `true` when the host handed
   * it to its SDK, and `false` when it was dropped: an invalid log (see
   * `readPlatformAnalyticsLog`), a log type the host does not send, no host
   * analytics, or an SDK failure. `true` does not mean the platform stored it.
   */
  log(entry: PlatformAnalyticsLog): Promise<boolean>;
}

export const platformAnalyticsParamLimit = 8;
export const platformAnalyticsStringMaxLength = 64;
/** Numbers must stay below this magnitude (15 digits). */
export const platformAnalyticsNumberLimit = 1e15;

const logNamePattern = /^[a-z][a-z0-9_]{1,63}$/u;
const providerPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const paramKeyPattern = /^[a-z][a-z0-9_]{0,31}$/u;
/** Names a host SDK reserves next to the parameters. */
const reservedParamKeys = new Set(['log_name', 'log_type', 'params']);
/**
 * Parameter names that hold an identifier or a score: such a word as a whole
 * `_`-separated segment anywhere in the name (`room_id`, `user_id_hash`), a
 * name ending in `score(s)` (`highscore`), or a person or place noun joined to
 * `id` (`userid`, `roomid`).
 */
const identifyingParamKeyPatterns: readonly RegExp[] = [
  /(?:^|_)(?:id|ids|uid|uuid|key|keys|token|tokens|email|score|scores)(?:_|$)/u,
  /scores?$/u,
  /(?:user|player|account|member|room|match|session|device|game|invite)ids?$/u,
];
const controlCharacterPattern = /[\u0000-\u001f\u007f]/u;
/** A run of hex digits long enough to be a numeric or hashed identifier. */
const hexIdentifierPattern = /[0-9a-f-]{16,}/giu;
/** An opaque token: a long run of word characters that contains a digit. */
const opaqueTokenPattern = /[a-z0-9_-]{32,}/giu;

/**
 * The log a sink may forward, or `undefined` when any part of it is invalid:
 * the whole log is dropped rather than forwarded without a parameter. A valid
 * log has a known `logType`, a `logName` matching lowercase snake_case of 2 to
 * 64 characters, and `params` as a plain object of at most eight entries whose
 * keys are lowercase snake_case of up to 32 characters and whose values are
 * finite numbers below 1e15 in magnitude, booleans, or strings of up to 64
 * characters.
 *
 * Refused as identifiers: keys `log_name`, `log_type`, and `params`; keys with
 * `id`, `ids`, `uid`, `uuid`, `key(s)`, `token(s)`, `email`, or `score(s)` as a
 * `_`-separated segment (`id`, `room_id`, `user_id_hash`, `anonymous_key`), keys
 * ending in `score(s)` (`highscore`), and keys such as `userid` or `roomid`;
 * and string values that contain `@` or `://`, a control character, a run of
 * 16 or more hex digits with a digit in it, or a 32-character run of word
 * characters with a digit in it. Numbers are checked only for magnitude: a
 * score under a neutral name passes, so the game must not send one.
 *
 * The result is a fresh frozen copy that always has `params`.
 */
export function readPlatformAnalyticsLog(value: unknown): Required<PlatformAnalyticsLog> | undefined {
  try {
    if (!isPlainRecord(value)) {
      return undefined;
    }
    const { logName, logType, params } = value;
    if (typeof logName !== 'string' || !logNamePattern.test(logName) || !isLogType(logType)) {
      return undefined;
    }
    const kept = readParams(params);
    return kept === undefined ? undefined : Object.freeze({ logName, logType, params: kept });
  } catch {
    // A throwing getter or proxy is no log.
    return undefined;
  }
}

/**
 * A status read from an untrusted answer (a host bridge response), or
 * `undefined` when it is not one. `logTypes` keeps only known, distinct types,
 * and an `unsupported` status always lists none.
 */
export function readPlatformAnalyticsStatus(value: unknown): PlatformAnalyticsStatus | undefined {
  try {
    if (!isPlainRecord(value)) {
      return undefined;
    }
    const { provider, state, logTypes } = value;
    if (typeof provider !== 'string' || !providerPattern.test(provider)
      || (state !== 'available' && state !== 'unsupported') || !Array.isArray(logTypes)) {
      return undefined;
    }
    const types = state === 'available'
      ? platformAnalyticsLogTypes.filter((type) => logTypes.includes(type))
      : [];
    return Object.freeze({ provider, state, logTypes: Object.freeze(types) });
  } catch {
    return undefined;
  }
}

const unsupportedStatus: PlatformAnalyticsStatus = Object.freeze({
  provider: 'none',
  state: 'unsupported',
  logTypes: Object.freeze([]),
});

/** A sink for targets without platform analytics: every log is dropped. */
export function createUnsupportedPlatformAnalyticsSink(): PlatformAnalyticsSink {
  return {
    async getStatus() {
      return unsupportedStatus;
    },
    async log() {
      return false;
    },
  };
}

function readParams(params: unknown): PlatformAnalyticsParams | undefined {
  if (params === undefined) {
    return Object.freeze({});
  }
  if (!isPlainRecord(params)) {
    return undefined;
  }
  const entries = Object.entries(params);
  if (entries.length > platformAnalyticsParamLimit) {
    return undefined;
  }
  const kept: Record<string, PlatformAnalyticsParamValue> = {};
  for (const [key, item] of entries) {
    if (!isParamKey(key) || !isParamValue(item)) {
      return undefined;
    }
    kept[key] = item;
  }
  return Object.freeze(kept);
}

function isParamKey(key: string): boolean {
  return paramKeyPattern.test(key)
    && !reservedParamKeys.has(key)
    && !identifyingParamKeyPatterns.some((pattern) => pattern.test(key));
}

function isParamValue(value: unknown): value is PlatformAnalyticsParamValue {
  if (typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    // Sixteen or more digits look like an id, as a string of them does.
    return Number.isFinite(value) && Math.abs(value) < platformAnalyticsNumberLimit;
  }
  return typeof value === 'string'
    && value.length <= platformAnalyticsStringMaxLength
    && !value.includes('@')
    && !value.includes('://')
    && !controlCharacterPattern.test(value)
    && !containsIdentifierRun(value);
}

/** Every run is checked: a digit-free first run must not hide a later identifier. */
function containsIdentifierRun(value: string): boolean {
  return [hexIdentifierPattern, opaqueTokenPattern].some((pattern) =>
    Array.from(value.matchAll(pattern), (match) => match[0]).some((run) => /\d/u.test(run)),
  );
}

function isLogType(value: unknown): value is PlatformAnalyticsLogType {
  return typeof value === 'string' && (platformAnalyticsLogTypes as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
