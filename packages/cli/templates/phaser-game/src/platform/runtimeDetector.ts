import type { PlatformTarget } from '@mpgd/platform';

const validTargets = new Set<string>([
  'android',
  'ios',
  'ait',
  'reddit',
  'telegram',
  'tauri',
] satisfies readonly PlatformTarget[]);

export interface RuntimeConfig {
  readonly target: PlatformTarget;
  readonly appVersion: string;
  readonly buildId: string;
  readonly debug: boolean;
}

export function detectRuntime(): RuntimeConfig {
  return {
    target: normalizeTarget(__APP_TARGET__),
    appVersion: __APP_VERSION__,
    buildId: __BUILD_ID__,
    debug: __DEBUG_BUILD__,
  };
}

export function normalizeTarget(value: string): PlatformTarget {
  return validTargets.has(value) ? (value as PlatformTarget) : 'browser';
}
