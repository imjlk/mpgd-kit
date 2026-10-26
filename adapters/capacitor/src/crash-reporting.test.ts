import type { FirebaseCrashlyticsPlugin } from '@capacitor-firebase/crashlytics';
import type {
  CrashErrorEventListener,
  CrashErrorEventTarget,
  CrashReporter,
} from '@mpgd/platform/crash-reporting';
import { describe, expect, it, vi } from 'vitest';

import {
  capacitorCrashlyticsPluginName,
  createCapacitorCrashReporter,
  createCapacitorGatewayCrashReporting,
  type CapacitorCrashlyticsPlugin,
  type CrashCollectionPreferenceStore,
} from './crash-reporting.js';
import { createCapacitorPlatformGateway } from './index.js';

// The plugin's own declarations must satisfy the calls the reporter makes.
const pluginShape: (plugin: FirebaseCrashlyticsPlugin) => CapacitorCrashlyticsPlugin = (plugin) => plugin;
void pluginShape;

function createPlugin(overrides: Partial<CapacitorCrashlyticsPlugin> = {}) {
  const plugin = {
    setCustomKey: vi.fn<CapacitorCrashlyticsPlugin['setCustomKey']>(async () => {}),
    log: vi.fn<CapacitorCrashlyticsPlugin['log']>(async () => {}),
    setEnabled: vi.fn<CapacitorCrashlyticsPlugin['setEnabled']>(async () => {}),
    isEnabled: vi.fn<CapacitorCrashlyticsPlugin['isEnabled']>(async () => ({ enabled: true })),
    deleteUnsentReports: vi.fn<CapacitorCrashlyticsPlugin['deleteUnsentReports']>(async () => {}),
    recordException: vi.fn<CapacitorCrashlyticsPlugin['recordException']>(async () => {}),
  };
  return Object.assign(plugin, overrides) as typeof plugin;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    await Promise.resolve();
  }
}

function memoryPreference(initial?: boolean): CrashCollectionPreferenceStore & { value?: boolean } {
  const store: CrashCollectionPreferenceStore & { value?: boolean } = {
    ...(initial === undefined ? {} : { value: initial }),
    read: () => store.value,
    write(enabled) {
      store.value = enabled;
    },
  };
  return store;
}

// Each spread gets its own preference store, so tests do not share a choice.
const base = {
  target: 'android',
  appVersion: '1.2.3',
  buildId: 'build-7',
  get collectionPreference() {
    return memoryPreference();
  },
} as const;

describe('createCapacitorCrashReporter', () => {
  it('is unavailable when the shell has no Crashlytics plugin', async () => {
    const isPluginAvailable = vi.fn(() => false);
    const reporter = createCapacitorCrashReporter({ ...base, isPluginAvailable });
    expect(isPluginAvailable).toHaveBeenCalledWith(capacitorCrashlyticsPluginName);
    expect(await reporter.getStatus()).toEqual({
      provider: 'firebase-crashlytics',
      state: 'not-installed',
    });
    await reporter.recordError(new Error('x'));
  });

  it('sets non-personal context once and records redacted errors with frames', async () => {
    const plugin = createPlugin();
    const reporter = createCapacitorCrashReporter({
      ...base,
      isPluginAvailable: () => true,
      plugin,
      context: {
        content_version: 5,
        epoch_ms: 1_793_000_000_000,
        ratio: 0.5,
        'Player Id': 'p-1',
        mpgd_target: 'spoofed',
      },
    });
    const error = new TypeError('failed https://api.example.com/x?token=secret');
    error.stack = 'TypeError: failed\n    at tick (https://localhost/assets/index.js:10:2)';
    await reporter.recordError(error, { source: 'uncaught' });
    await reporter.recordError('second');
    expect(plugin.setCustomKey.mock.calls.map(([options]) => options)).toEqual([
      { key: 'mpgd_target', value: 'android', type: 'string' },
      { key: 'mpgd_build_id', value: 'build-7', type: 'string' },
      { key: 'mpgd_app_version', value: '1.2.3', type: 'string' },
      { key: 'mpgd_adapter', value: 'capacitor', type: 'string' },
      { key: 'content_version', value: 5, type: 'int' },
      // Outside int32: the Android plugin reads `long` as a Java Integer.
      { key: 'epoch_ms', value: 1_793_000_000_000, type: 'double' },
      { key: 'ratio', value: 0.5, type: 'double' },
    ]);
    expect(plugin.recordException.mock.calls.map(([options]) => options)).toEqual([
      {
        message: '[uncaught] TypeError: failed https://api.example.com/x?<redacted>',
        stacktrace: [{ functionName: 'tick', fileName: '/assets/index.js', lineNumber: 10 }],
      },
      { message: '[game] Error: second' },
    ]);
  });

  it('keeps long hex build ids and skips a key the SDK refuses', async () => {
    const buildId = '3f9a6c1e0b7d4a2f9e8c7b6a5d4c3b2a1f0e9d8c';
    const plugin = createPlugin({
      setCustomKey: vi.fn(async (options: { readonly key: string }) => {
        if (options.key === 'bad_key') {
          throw new Error('value must be provided.');
        }
      }),
    });
    const reporter = createCapacitorCrashReporter({
      ...base,
      buildId,
      isPluginAvailable: () => true,
      plugin,
      context: { bad_key: 1 },
    });
    expect(await reporter.getStatus()).toEqual({ provider: 'firebase-crashlytics', state: 'available' });
    expect(plugin.setCustomKey).toHaveBeenCalledWith({ key: 'mpgd_build_id', value: buildId, type: 'string' });
    await reporter.recordError(new Error('x'));
    expect(plugin.recordException).toHaveBeenCalledTimes(1);
  });

  it('holds JavaScript reports until consent when requireConsent is set', async () => {
    const plugin = createPlugin();
    const reporter = createCapacitorCrashReporter({
      ...base,
      requireConsent: true,
      isPluginAvailable: () => true,
      plugin,
    });
    // The context keys are set at creation, before any report, so a native
    // crash carries them too; keys stay on the device until a report is sent.
    await flushMicrotasks();
    expect(plugin.setCustomKey).toHaveBeenCalledWith({ key: 'mpgd_target', value: 'android', type: 'string' });
    await expect(reporter.recordError(new Error('before consent'))).resolves.toBe(false);
    await reporter.log('before consent');
    expect(plugin.recordException).not.toHaveBeenCalled();
    expect(plugin.log).not.toHaveBeenCalled();
    expect((await reporter.getStatus()).collectionEnabled).toBe(false);
    await reporter.setCollectionEnabled(true);
    await expect(reporter.recordError(new Error('after consent'))).resolves.toBe(true);
    expect(plugin.recordException).toHaveBeenCalledTimes(1);
  });

  it('keeps the player choice across launches', async () => {
    const preference = memoryPreference();
    const plugin = createPlugin();
    const first = createCapacitorCrashReporter({
      ...base, collectionPreference: preference, isPluginAvailable: () => true, plugin,
    });
    await first.setCollectionEnabled(false);
    expect(preference.value).toBe(false);
    // The next launch: Android cannot read the SDK's choice back.
    const next = createCapacitorCrashReporter({
      ...base, collectionPreference: preference, isPluginAvailable: () => true, plugin,
    });
    await expect(next.recordError(new Error('after opt-out'))).resolves.toBe(false);
    await next.log('after opt-out');
    expect(plugin.recordException).not.toHaveBeenCalled();
    expect(plugin.log).not.toHaveBeenCalled();
    // Consent given in an earlier launch satisfies requireConsent.
    const consented = createCapacitorCrashReporter({
      ...base,
      requireConsent: true,
      collectionPreference: memoryPreference(true),
      isPluginAvailable: () => true,
      plugin,
    });
    await expect(consented.recordError(new Error('consented'))).resolves.toBe(true);
  });

  it('re-applies a stored opt-out the SDK did not take, at start and with later reports', async () => {
    const preference = memoryPreference();
    let nativeFailures = 1;
    const plugin = createPlugin({
      setEnabled: vi.fn(async () => {
        if (nativeFailures > 0) {
          nativeFailures -= 1;
          throw new Error('native failure');
        }
      }),
    });
    const first = createCapacitorCrashReporter({
      ...base, collectionPreference: preference, isPluginAvailable: () => true, plugin,
    });
    await first.setCollectionEnabled(false);
    expect(preference.value).toBe(false);
    expect(plugin.deleteUnsentReports).not.toHaveBeenCalled();
    // In the same session the next dropped report retries it.
    await expect(first.recordError(new Error('x'))).resolves.toBe(false);
    expect(plugin.setEnabled).toHaveBeenLastCalledWith({ enabled: false });
    expect(plugin.deleteUnsentReports).toHaveBeenCalledTimes(1);
    expect(plugin.recordException).not.toHaveBeenCalled();

    // A restart applies the stored opt-out again before any report.
    plugin.setEnabled.mockClear();
    plugin.deleteUnsentReports.mockClear();
    nativeFailures = 1;
    const restarted = createCapacitorCrashReporter({
      ...base, collectionPreference: preference, isPluginAvailable: () => true, plugin,
    });
    await flushMicrotasks();
    expect(plugin.setEnabled).toHaveBeenCalledWith({ enabled: false });
    expect(plugin.deleteUnsentReports).not.toHaveBeenCalled();
    // That attempt failed too; the next report retries until it succeeds.
    await restarted.log('dropped');
    expect(plugin.setEnabled).toHaveBeenCalledTimes(2);
    expect(plugin.deleteUnsentReports).toHaveBeenCalledTimes(1);
    await restarted.log('dropped again');
    expect(plugin.setEnabled).toHaveBeenCalledTimes(2);
    expect(plugin.log).not.toHaveBeenCalled();
  });

  it('retries a native opt-in the SDK did not take', async () => {
    const preference = memoryPreference();
    let nativeFailures = 1;
    const plugin = createPlugin({
      setEnabled: vi.fn(async () => {
        if (nativeFailures > 0) {
          nativeFailures -= 1;
          throw new Error('native failure');
        }
      }),
    });
    const first = createCapacitorCrashReporter({
      ...base,
      requireConsent: true,
      collectionPreference: preference,
      isPluginAvailable: () => true,
      plugin,
    });
    await first.setCollectionEnabled(true);
    expect(preference.value).toBe(true);
    expect(plugin.setEnabled).toHaveBeenCalledTimes(1);
    // The next report retries the opt-in, then records.
    await expect(first.recordError(new Error('x'))).resolves.toBe(true);
    expect(plugin.setEnabled).toHaveBeenCalledTimes(2);
    expect(plugin.setEnabled).toHaveBeenLastCalledWith({ enabled: true });
    await first.log('ok');
    expect(plugin.setEnabled).toHaveBeenCalledTimes(2);

    // A restart applies the stored opt-in to the SDK again.
    plugin.setEnabled.mockClear();
    createCapacitorCrashReporter({
      ...base,
      requireConsent: true,
      collectionPreference: preference,
      isPluginAvailable: () => true,
      plugin,
    });
    await flushMicrotasks();
    expect(plugin.setEnabled).toHaveBeenCalledWith({ enabled: true });
    expect(plugin.deleteUnsentReports).not.toHaveBeenCalled();
  });

  it('still applies the native opt-out when the preference store throws', async () => {
    const plugin = createPlugin();
    const reporter = createCapacitorCrashReporter({
      ...base,
      collectionPreference: {
        read() {
          throw new Error('storage unavailable');
        },
        write() {
          throw new Error('quota exceeded');
        },
      },
      isPluginAvailable: () => true,
      plugin,
    });
    await expect(reporter.setCollectionEnabled(false)).resolves.toBeUndefined();
    expect(plugin.setEnabled).toHaveBeenCalledWith({ enabled: false });
    expect(plugin.deleteUnsentReports).toHaveBeenCalledTimes(1);
    await expect(reporter.recordError(new Error('after opt-out'))).resolves.toBe(false);
  });

  it('takes a missing choice from the iOS SDK', async () => {
    const plugin = createPlugin({ isEnabled: vi.fn(async () => ({ enabled: false })) });
    const reporter = createCapacitorCrashReporter({
      ...base, target: 'ios', isPluginAvailable: () => true, plugin,
    });
    await expect(reporter.recordError(new Error('x'))).resolves.toBe(false);
    expect(plugin.recordException).not.toHaveBeenCalled();
  });

  it('does not record a report that races with turning collection off', async () => {
    const plugin = createPlugin();
    const reporter = createCapacitorCrashReporter({ ...base, isPluginAvailable: () => true, plugin });
    // Both start while the context keys are still being set.
    const report = reporter.recordError(new Error('raced'));
    const breadcrumb = reporter.log('raced');
    const toggle = reporter.setCollectionEnabled(false);
    await expect(report).resolves.toBe(false);
    await breadcrumb;
    await toggle;
    expect(plugin.recordException).not.toHaveBeenCalled();
    expect(plugin.log).not.toHaveBeenCalled();
    expect(plugin.deleteUnsentReports).toHaveBeenCalledTimes(1);
  });

  it('reports not-configured and stops calling when Firebase is not set up', async () => {
    const plugin = createPlugin({
      setCustomKey: vi.fn(async () => {
        throw new Error('Default FirebaseApp is not initialized');
      }),
    });
    const reporter = createCapacitorCrashReporter({
      ...base,
      isPluginAvailable: () => true,
      plugin,
    });
    expect(await reporter.getStatus()).toEqual({
      provider: 'firebase-crashlytics',
      state: 'not-configured',
    });
    await reporter.recordError(new Error('x'));
    await reporter.log('x');
    await reporter.setCollectionEnabled(false);
    expect(plugin.recordException).not.toHaveBeenCalled();
    expect(plugin.log).not.toHaveBeenCalled();
    expect(plugin.setEnabled).not.toHaveBeenCalled();
  });

  it('applies the consent toggle and stops JavaScript reports when it is off', async () => {
    const plugin = createPlugin();
    const reporter = createCapacitorCrashReporter({
      ...base,
      isPluginAvailable: () => true,
      plugin,
    });
    await reporter.setCollectionEnabled(false);
    expect(plugin.setEnabled).toHaveBeenCalledWith({ enabled: false });
    expect(plugin.deleteUnsentReports).toHaveBeenCalledTimes(1);
    await reporter.recordError(new Error('x'));
    await reporter.log('breadcrumb');
    expect(plugin.recordException).not.toHaveBeenCalled();
    expect(plugin.log).not.toHaveBeenCalled();
    expect(await reporter.getStatus()).toEqual({
      provider: 'firebase-crashlytics',
      state: 'available',
      collectionEnabled: false,
    });
    await reporter.setCollectionEnabled(true);
    expect(plugin.setEnabled).toHaveBeenLastCalledWith({ enabled: true });
    expect(plugin.deleteUnsentReports).toHaveBeenCalledTimes(1);
    await reporter.log('user jane@example.com opened shop');
    expect(plugin.log).toHaveBeenCalledWith({ message: 'user <email> opened shop' });
  });

  it('reads collection state on iOS only and never rejects on plugin failures', async () => {
    const plugin = createPlugin({
      isEnabled: vi.fn(async () => ({ enabled: false })),
      recordException: vi.fn(async () => {
        throw new Error('native failure');
      }),
      log: vi.fn(async () => {
        throw new Error('native failure');
      }),
      setEnabled: vi.fn(async () => {
        throw new Error('native failure');
      }),
    });
    const ios = createCapacitorCrashReporter({
      ...base,
      target: 'ios',
      isPluginAvailable: () => true,
      plugin,
    });
    expect(await ios.getStatus()).toEqual({
      provider: 'firebase-crashlytics',
      state: 'available',
      collectionEnabled: false,
    });
    await expect(ios.recordError(new Error('x'))).resolves.toBe(false);
    await expect(ios.log('x')).resolves.toBeUndefined();
    await expect(ios.setCollectionEnabled(true)).resolves.toBeUndefined();

    const androidPlugin = createPlugin();
    const android = createCapacitorCrashReporter({
      ...base,
      isPluginAvailable: () => true,
      plugin: androidPlugin,
    });
    expect(await android.getStatus()).toEqual({
      provider: 'firebase-crashlytics',
      state: 'available',
    });
    expect(androidPlugin.isEnabled).not.toHaveBeenCalled();
  });
});

function createEventTarget(): CrashErrorEventTarget & {
  emit(type: 'error' | 'unhandledrejection', event: unknown): void;
  size(): number;
} {
  const listeners = new Map<string, Set<CrashErrorEventListener>>();
  return {
    addEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    size() {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    },
  };
}

describe('createCapacitorGatewayCrashReporting', () => {
  it('captures WebView errors only when the plugin is present', async () => {
    const absentTarget = createEventTarget();
    const absent = createCapacitorGatewayCrashReporting({
      ...base,
      options: { isPluginAvailable: () => false, errorTarget: absentTarget },
    });
    expect(absentTarget.size()).toBe(0);
    expect((await absent.reporter.getStatus()).state).toBe('not-installed');

    const plugin = createPlugin();
    const target = createEventTarget();
    const present = createCapacitorGatewayCrashReporting({
      ...base,
      options: {
        isPluginAvailable: () => true,
        plugin,
        errorTarget: target,
        collectionPreference: memoryPreference(),
      },
    });
    expect(target.size()).toBe(2);
    target.emit('unhandledrejection', { reason: new Error('lost promise') });
    await flushMicrotasks();
    expect(plugin.recordException).toHaveBeenCalledTimes(1);
    expect(plugin.recordException.mock.calls[0]?.[0].message).toBe(
      '[unhandled-rejection] Error: lost promise',
    );
    present.dispose();
    expect(target.size()).toBe(0);
  });

  it('respects captureGlobalErrors: false and a custom reporter', () => {
    const target = createEventTarget();
    createCapacitorGatewayCrashReporting({
      ...base,
      options: {
        isPluginAvailable: () => true,
        plugin: createPlugin(),
        errorTarget: target,
        captureGlobalErrors: false,
        collectionPreference: memoryPreference(),
      },
    });
    expect(target.size()).toBe(0);
    const reporter: CrashReporter = {
      getStatus: async () => ({ provider: 'custom', state: 'available' }),
      recordError: async () => true,
      log: async () => {},
      setCollectionEnabled: async () => {},
    };
    const custom = createCapacitorGatewayCrashReporting({
      ...base,
      options: { reporter, errorTarget: target, isPluginAvailable: () => false },
    });
    expect(custom.reporter).toBe(reporter);
    expect(target.size()).toBe(2);
    custom.dispose();
  });
});

describe('createCapacitorPlatformGateway crash reporting', () => {
  it('exposes the reporter, removes listeners on dispose, and can be turned off', async () => {
    const bridge = { request: async () => ({ ok: true as const, data: {} }) } as never;
    const target = createEventTarget();
    const gateway = createCapacitorPlatformGateway({
      ...base,
      bridge,
      crashReporting: {
        isPluginAvailable: () => true,
        plugin: createPlugin(),
        errorTarget: target,
        collectionPreference: memoryPreference(),
      },
    });
    expect((await gateway.crashReporter?.getStatus())?.state).toBe('available');
    expect(target.size()).toBe(2);
    await gateway.lifecycle.dispose?.();
    expect(target.size()).toBe(0);

    const off = createCapacitorPlatformGateway({
      ...base,
      bridge,
      crashReporting: false,
    });
    expect(off.crashReporter).toBeUndefined();
  });
});
