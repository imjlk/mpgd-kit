import { describe, expect, it } from 'vitest';

import {
  crashContextKeyLimit,
  createUnavailableCrashReporter,
  formatCrashMessage,
  installCrashErrorCapture,
  normalizeCrashError,
  parseCrashStackFrames,
  redactCrashText,
  sanitizeCrashContext,
  type CrashErrorEventListener,
  type CrashErrorEventTarget,
  type CrashReporter,
  type RecordCrashErrorOptions,
} from './crash-reporting.js';

describe('redactCrashText', () => {
  it('drops URL queries and fragments, e-mail addresses, and tokens', () => {
    const text = [
      'GET https://api.example.com/v1/players?id=42&token=abc failed',
      'see capacitor://localhost/index.html#session=xyz',
      'player mail jane.doe+1@example.co.kr',
      'Authorization: Bearer abc.def-ghi',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
      'refresh 3f9a6c1e0b7d4a2f9e8c7b6a5d4c3b2a1f0e9d8c',
    ].join('\n');
    const redacted = redactCrashText(text);
    expect(redacted).toContain('https://api.example.com/v1/players?<redacted>');
    expect(redacted).toContain('capacitor://localhost/index.html?<redacted>');
    expect(redacted).not.toContain('token=abc');
    expect(redacted).not.toContain('session=xyz');
    expect(redacted).toContain('<email>');
    expect(redacted).not.toContain('jane.doe');
    expect(redacted).toContain('Bearer <redacted>');
    expect(redacted).toContain('<jwt>');
    expect(redacted).not.toContain('3f9a6c1e0b7d4a2f9e8c7b6a5d4c3b2a1f0e9d8c');
    expect(redactCrashText(redacted)).toBe(redacted);
    // Control characters other than newline and tab become spaces.
    expect(redactCrashText('a\u0000b')).toBe('a b');
  });

  it('keeps long words without digits and truncates to the limit', () => {
    expect(redactCrashText('CannotReadPropertiesOfUndefinedReadingSomething')).toBe(
      'CannotReadPropertiesOfUndefinedReadingSomething',
    );
    const long = redactCrashText('x '.repeat(2000));
    expect(long).toHaveLength(1024);
    expect(long.endsWith('…')).toBe(true);
    expect(redactCrashText('abcdef', 4)).toBe('abc…');
  });
});

describe('parseCrashStackFrames', () => {
  it('parses V8 frames and drops the origin and query', () => {
    const stack = [
      'TypeError: boom',
      '    at Scene.update (https://localhost/assets/index-abc.js?v=1:12:34)',
      '    at https://localhost/assets/vendor.js:7:1',
      '    at <anonymous>',
      '    at async loop (https://localhost/assets/index-abc.js:99:2)',
    ].join('\n');
    expect(parseCrashStackFrames(stack)).toEqual([
      { functionName: 'Scene.update', fileName: '/assets/index-abc.js', lineNumber: 12 },
      { fileName: '/assets/vendor.js', lineNumber: 7 },
      { functionName: 'async loop', fileName: '/assets/index-abc.js', lineNumber: 99 },
    ]);
  });

  it('parses WebKit frames from the iOS WebView', () => {
    const stack = [
      'update@capacitor://localhost/assets/index-abc.js:12:34',
      '@capacitor://localhost/assets/index-abc.js:3:1',
      'global code',
    ].join('\n');
    expect(parseCrashStackFrames(stack)).toEqual([
      { functionName: 'update', fileName: '/assets/index-abc.js', lineNumber: 12 },
      { fileName: '/assets/index-abc.js', lineNumber: 3 },
    ]);
  });

  it('keeps at most the frame limit', () => {
    const stack = Array.from({ length: 10 }, (_, index) => `    at f${index} (/a.js:${index + 1}:1)`)
      .join('\n');
    expect(parseCrashStackFrames(stack, 3).map((frame) => frame.functionName)).toEqual(['f0', 'f1', 'f2']);
  });
});

describe('normalizeCrashError', () => {
  it('reads errors, strings, and other values without serializing objects', () => {
    const error = new RangeError('bad index for jane@example.com');
    const normalized = normalizeCrashError(error);
    expect(normalized.name).toBe('RangeError');
    expect(normalized.message).toBe('bad index for <email>');
    expect(normalized.frames.length).toBeGreaterThan(0);

    expect(normalizeCrashError('plain')).toEqual({ name: 'Error', message: 'plain', frames: [] });
    expect(normalizeCrashError({ playerId: 'p-1', secret: 'x' })).toEqual({
      name: 'Error',
      message: 'Non-error object thrown',
      frames: [],
    });
    expect(normalizeCrashError(42).message).toBe('Non-error number thrown');
    expect(normalizeCrashError(null).message).toBe('Non-error null thrown');
    expect(normalizeCrashError([1]).message).toBe('Non-error array thrown');
  });

  it('survives hostile getters', () => {
    const hostile = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('no');
      },
    });
    expect(normalizeCrashError(hostile).message).toBe('Non-error object thrown');
  });

  it('formats the report message with its source', () => {
    expect(formatCrashMessage(normalizeCrashError(new TypeError('x')), 'uncaught')).toBe(
      '[uncaught] TypeError: x',
    );
  });
});

describe('sanitizeCrashContext', () => {
  it('keeps only well-formed keys and plain values', () => {
    expect(sanitizeCrashContext({
      build_id: 'b-1',
      app_version: '1.2.3',
      debug: false,
      level: 3,
      'Bad-Key': 'x',
      nested: { a: 1 },
      nan: Number.NaN,
      url: 'https://example.com/?player=1',
    })).toEqual({
      build_id: 'b-1',
      app_version: '1.2.3',
      debug: false,
      level: 3,
      url: 'https://example.com/?<redacted>',
    });
  });

  it('caps the number of keys and the value length', () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`k${index}`, index]));
    expect(Object.keys(sanitizeCrashContext(many))).toHaveLength(crashContextKeyLimit);
    expect((sanitizeCrashContext({ long: 'y'.repeat(500) }).long as string).length).toBe(128);
  });
});

describe('createUnavailableCrashReporter', () => {
  it('is a no-op reporter', async () => {
    const reporter = createUnavailableCrashReporter();
    expect(await reporter.getStatus()).toEqual({ provider: 'none', state: 'unsupported' });
    await expect(reporter.recordError(new Error('x'))).resolves.toBeUndefined();
    await expect(reporter.log('x')).resolves.toBeUndefined();
    await expect(reporter.setCollectionEnabled(false)).resolves.toBeUndefined();
    const notInstalled = createUnavailableCrashReporter({
      provider: 'firebase-crashlytics',
      state: 'not-installed',
    });
    expect((await notInstalled.getStatus()).state).toBe('not-installed');
  });
});

function createEventTarget(): CrashErrorEventTarget & {
  emit(type: 'error' | 'unhandledrejection', event: unknown): void;
  count(): number;
} {
  const listeners = new Map<string, Set<CrashErrorEventListener>>();
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    count() {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    },
  };
}

function createRecordingReporter(): CrashReporter & {
  readonly calls: { readonly error: unknown; readonly options?: RecordCrashErrorOptions }[];
} {
  const calls: { readonly error: unknown; readonly options?: RecordCrashErrorOptions }[] = [];
  return {
    calls,
    async getStatus() {
      return { provider: 'test', state: 'available' };
    },
    async recordError(error, options) {
      calls.push({ error, ...(options === undefined ? {} : { options }) });
    },
    async log() {},
    async setCollectionEnabled() {},
  };
}

describe('installCrashErrorCapture', () => {
  it('reports uncaught errors and unhandled rejections once each', () => {
    const target = createEventTarget();
    const reporter = createRecordingReporter();
    const dispose = installCrashErrorCapture({ reporter, target });
    const error = new Error('boom');
    target.emit('error', { error, message: 'boom' });
    target.emit('error', { error, message: 'boom' });
    target.emit('unhandledrejection', { reason: 'nope' });
    target.emit('error', { message: 'Script error.' });
    // A resource load failure carries neither an error nor a message.
    target.emit('error', {});
    target.emit('error', null);
    expect(reporter.calls).toEqual([
      { error, options: { source: 'uncaught' } },
      { error: 'nope', options: { source: 'unhandled-rejection' } },
      { error: 'Script error.', options: { source: 'uncaught' } },
    ]);
    dispose();
    dispose();
    expect(target.count()).toBe(0);
    target.emit('error', { error: new Error('later') });
    expect(reporter.calls).toHaveLength(3);
  });

  it('stops after the session limit and swallows reporter failures', async () => {
    const target = createEventTarget();
    let attempts = 0;
    const reporter: CrashReporter = {
      ...createRecordingReporter(),
      async recordError() {
        attempts += 1;
        throw new Error('reporter broke');
      },
    };
    installCrashErrorCapture({ reporter, target, maxReports: 2 });
    for (let index = 0; index < 5; index += 1) {
      target.emit('error', { error: new Error(`e${index}`) });
    }
    await Promise.resolve();
    expect(attempts).toBe(2);
  });
});
