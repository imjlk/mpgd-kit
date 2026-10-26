/**
 * Crash reporting port (`@mpgd/platform/crash-reporting`).
 *
 * A `CrashReporter` sends crash and error diagnostics to the crash service a
 * target ships with (Firebase Crashlytics in the Capacitor shells). The port
 * carries only non-personal context: the target, the build, and keys the game
 * adds through `sanitizeCrashContext`. It has no user id: the kit never links
 * crash reports to a player (see docs/STORE_PRIVACY_DISCLOSURES.md).
 *
 * Everything here is SDK-free and DOM-free; adapters implement the port and
 * `installCrashErrorCapture` listens on any event target with the browser's
 * `error` and `unhandledrejection` event shapes.
 */

/** Value of one context key, as crash services store custom keys. */
export type CrashContextValue = string | number | boolean;

/** Non-personal key/value context attached to every report. */
export type CrashReporterContext = Readonly<Record<string, CrashContextValue>>;

/**
 * `available`: the crash service is installed and configured; reports are
 * collected unless the player turned collection off.
 * `not-installed`: the target ships without the crash service.
 * `not-configured`: the service is installed but could not start (for
 * example the Firebase configuration file is missing).
 * `unsupported`: the target has no crash service at all.
 */
export type CrashReporterState = 'available' | 'not-installed' | 'not-configured' | 'unsupported';

export interface CrashReporterStatus {
  /** The crash service, for example `firebase-crashlytics`; `none` when there is none. */
  readonly provider: string;
  readonly state: CrashReporterState;
  /**
   * Whether the service sends reports, when the SDK can tell (Crashlytics
   * reports it on iOS only). Absent when unknown.
   */
  readonly collectionEnabled?: boolean;
}

/** Where a recorded error came from, kept in the report's message prefix. */
export type CrashErrorSource = 'game' | 'uncaught' | 'unhandled-rejection';

export interface RecordCrashErrorOptions {
  /** Defaults to `game`. */
  readonly source?: CrashErrorSource;
}

/**
 * Crash reporting as games see it. Every method resolves; a reporter never
 * throws into game code, and an unavailable service makes every call a no-op.
 * Native crashes are captured by the native SDK itself and need no call.
 */
export interface CrashReporter {
  getStatus(): Promise<CrashReporterStatus>;
  /**
   * Record a non-fatal report for an error the game handled (or one
   * `installCrashErrorCapture` caught). The message is redacted
   * (`redactCrashText`) and the stack is reduced to function, file, and line.
   * Resolves `true` when the report reached the crash service, and `false`
   * when it was dropped (no service, collection off, or an SDK failure).
   */
  recordError(error: unknown, options?: RecordCrashErrorOptions): Promise<boolean>;
  /** A breadcrumb sent with the next report; redacted and truncated. */
  log(message: string): Promise<void>;
  /**
   * The player's consent toggle. The SDK persists the choice across launches;
   * turning it off also deletes reports not sent yet. A change may only take
   * full effect on the next launch (Crashlytics), so a settings screen should
   * say so. Resolves without effect when the service is unavailable.
   */
  setCollectionEnabled(enabled: boolean): Promise<void>;
}

/** A stack frame in the shape crash services accept for JavaScript errors. */
export interface CrashStackFrame {
  readonly functionName?: string;
  readonly fileName?: string;
  readonly lineNumber?: number;
  /**
   * Kept to tell apart errors on one line of a minified bundle; a crash
   * service that takes no column (Crashlytics) gets the frame without it.
   */
  readonly columnNumber?: number;
}

/** An error reduced to what a report may carry. */
export interface NormalizedCrashError {
  readonly name: string;
  readonly message: string;
  readonly frames: readonly CrashStackFrame[];
}

/** Longest message or log line a report carries; Crashlytics keeps 1 kB per key. */
export const crashTextMaxLength = 1024;
/** Most frames kept from one stack. */
export const crashStackFrameLimit = 64;
/** Most context keys kept; Crashlytics stores up to 64 custom keys. */
export const crashContextKeyLimit = 32;
const contextKeyPattern = /^[a-z][a-z0-9_]{0,39}$/u;
const contextValueMaxLength = 128;

/**
 * Remove values that may identify a player or carry a secret from text sent to
 * a crash service: URL query strings and fragments, e-mail addresses, bearer
 * tokens, JWTs, and long opaque tokens. Control characters become spaces, and
 * the result is cut to `maxLength` characters.
 */
export function redactCrashText(text: string, maxLength = crashTextMaxLength): string {
  const redacted = text
    // Query strings and fragments of absolute URLs (tokens, ids, e-mail).
    // An already redacted `?<redacted>` does not match again.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]+/giu, '$1?<redacted>')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gu, '<email>')
    .replace(/\bbearer\s+[\w~+/.=-]+/giu, 'Bearer <redacted>')
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]*/gu, '<jwt>')
    .replace(/\b[a-z0-9_-]{32,}\b/giu, (token) => (/\d/u.test(token) ? '<redacted>' : token))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ');
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}

function stringProperty(value: object, key: string): string | undefined {
  try {
    const property = (value as Readonly<Record<string, unknown>>)[key];
    return typeof property === 'string' ? property : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reduce any thrown value to a name, a redacted message, and stack frames.
 * Objects other than errors are never serialized, since their fields may hold
 * player data: only a string `name` and `message` are read.
 */
export function normalizeCrashError(error: unknown): NormalizedCrashError {
  if (typeof error === 'string') {
    return { name: 'Error', message: redactCrashText(error), frames: [] };
  }
  if (typeof error === 'object' && error !== null) {
    const name = stringProperty(error, 'name');
    const message = stringProperty(error, 'message');
    const stack = stringProperty(error, 'stack');
    return {
      name: redactCrashText(name !== undefined && name.length > 0 ? name : 'Error', 80),
      message: message === undefined
        ? `Non-error ${describeValue(error)} thrown`
        : redactCrashText(message),
      frames: stack === undefined ? [] : parseCrashStackFrames(stack),
    };
  }
  return { name: 'Error', message: `Non-error ${describeValue(error)} thrown`, frames: [] };
}

function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

const v8FramePattern = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+)(?::(\d+))?\)?\s*$/u;
const webkitFramePattern = /^\s*(.*?)@(.+?):(\d+)(?::(\d+))?\s*$/u;

/**
 * Parse V8 (`at fn (file:line:col)`) or, when the stack has no V8 frame,
 * WebKit/Gecko (`fn@file:line:col`) stack lines. File names keep only their
 * path: the origin (`https://localhost`, `capacitor://localhost`) and any
 * query or fragment are dropped.
 */
export function parseCrashStackFrames(
  stack: string,
  limit = crashStackFrameLimit,
): readonly CrashStackFrame[] {
  const frames: CrashStackFrame[] = [];
  const lines = stack.split('\n');
  // A V8 stack starts with the error's `Name: message` line, which may
  // contain `@` and `:<digits>`; only `at` lines are frames there.
  const pattern = lines.some((line) => /^\s*at\s/u.test(line))
    ? v8FramePattern
    : webkitFramePattern;
  for (const line of lines) {
    if (frames.length >= limit) {
      break;
    }
    const match = pattern.exec(line);
    if (match === null) {
      continue;
    }
    const [, functionName, file, lineText, columnText] = match;
    const lineNumber = Number(lineText);
    const columnNumber = columnText === undefined ? Number.NaN : Number(columnText);
    const fileName = crashFrameFileName(file ?? '');
    frames.push({
      ...(functionName === undefined || functionName.trim() === ''
        ? {}
        : { functionName: redactCrashText(functionName.trim(), 200) }),
      ...(fileName === '' ? {} : { fileName }),
      ...(Number.isSafeInteger(lineNumber) && lineNumber > 0 ? { lineNumber } : {}),
      ...(Number.isSafeInteger(columnNumber) && columnNumber > 0 ? { columnNumber } : {}),
    });
  }
  return frames;
}

function crashFrameFileName(file: string): string {
  const withoutQuery = file.replace(/[?#].*$/u, '');
  const withoutOrigin = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu, '');
  return redactCrashText(withoutOrigin, 300);
}

/**
 * Keep only context a report may carry: lowercase snake_case keys of up to 40
 * characters, finite numbers, booleans, and redacted strings of up to 128
 * characters, at most `crashContextKeyLimit` keys. Anything else is dropped.
 * It cannot tell a player id from a build id, so games pass only build and
 * device-independent facts here.
 */
export function sanitizeCrashContext(context: Readonly<Record<string, unknown>>): CrashReporterContext {
  const kept: Record<string, CrashContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    if (Object.keys(kept).length >= crashContextKeyLimit) {
      break;
    }
    if (!contextKeyPattern.test(key)) {
      continue;
    }
    if (typeof value === 'string') {
      kept[key] = redactCrashText(value, contextValueMaxLength);
    } else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      kept[key] = value;
    }
  }
  return kept;
}

/** The message a report carries: the source, the error name, and its message. */
export function formatCrashMessage(error: NormalizedCrashError, source: CrashErrorSource): string {
  return redactCrashText(`[${source}] ${error.name}: ${error.message}`);
}

/** A reporter for targets without a crash service: every call is a no-op. */
export function createUnavailableCrashReporter(
  status: CrashReporterStatus = { provider: 'none', state: 'unsupported' },
): CrashReporter {
  const frozen = Object.freeze({ ...status });
  return {
    async getStatus() {
      return frozen;
    },
    async recordError() {
      return false;
    },
    async log() {},
    async setCollectionEnabled() {},
  };
}

/** The listener shape `installCrashErrorCapture` registers. */
export type CrashErrorEventListener = (event: unknown) => void;

/**
 * The part of `EventTarget` (a browser `window`) the capture needs, kept
 * structural so this package stays DOM-free.
 */
export interface CrashErrorEventTarget {
  addEventListener(type: 'error' | 'unhandledrejection', listener: CrashErrorEventListener): void;
  removeEventListener(type: 'error' | 'unhandledrejection', listener: CrashErrorEventListener): void;
}

export interface CrashErrorCaptureOptions {
  readonly reporter: CrashReporter;
  readonly target: CrashErrorEventTarget;
  /**
   * Most reports the capture sends in one session; Crashlytics keeps only the
   * latest eight non-fatal reports per session anyway. Defaults to 8.
   */
  readonly maxReports?: number;
}

/**
 * Report uncaught errors and unhandled promise rejections from the WebView as
 * non-fatal errors. Identical errors (same name, message, and top frame) are
 * reported once, and at most `maxReports` per session. Returns a function that
 * removes the listeners. Resource load failures (an `error` event without an
 * error or a message) are ignored.
 */
export function installCrashErrorCapture(options: CrashErrorCaptureOptions): () => void {
  const maxReports = options.maxReports ?? 8;
  const seen = new Set<string>();
  let reported = 0;
  const report = (value: unknown, source: CrashErrorSource): void => {
    if (reported >= maxReports) {
      return;
    }
    const normalized = normalizeCrashError(value);
    const top = normalized.frames[0];
    // The whole top-frame location: in a minified bundle unrelated errors
    // often share a name, message, file, and line, and differ only in the
    // function or column.
    const key = [
      source,
      normalized.name,
      normalized.message,
      top?.functionName ?? '',
      top?.fileName ?? '',
      top?.lineNumber ?? '',
      top?.columnNumber ?? '',
    ].join('\u0000');
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    reported += 1;
    // A dropped report (collection off until consent, an SDK failure) gives
    // back its budget and may be reported when it happens again. The catch
    // keeps a faulty reporter from raising another unhandled rejection.
    const release = (): void => {
      seen.delete(key);
      reported -= 1;
    };
    options.reporter.recordError(value, { source }).then((sent) => {
      if (!sent) {
        release();
      }
    }, release);
  };
  const onError: CrashErrorEventListener = (event) => {
    if (typeof event !== 'object' || event === null) {
      return;
    }
    const { error, message } = event as { readonly error?: unknown; readonly message?: unknown };
    if (error !== undefined && error !== null) {
      report(error, 'uncaught');
    } else if (typeof message === 'string' && message.length > 0) {
      report(message, 'uncaught');
    }
  };
  const onRejection: CrashErrorEventListener = (event) => {
    if (typeof event !== 'object' || event === null) {
      return;
    }
    report((event as { readonly reason?: unknown }).reason, 'unhandled-rejection');
  };
  options.target.addEventListener('error', onError);
  options.target.addEventListener('unhandledrejection', onRejection);
  let installed = true;
  return () => {
    if (!installed) {
      return;
    }
    installed = false;
    options.target.removeEventListener('error', onError);
    options.target.removeEventListener('unhandledrejection', onRejection);
  };
}
