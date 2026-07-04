import type { PlatformTarget } from '@mpgd/platform';

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

function normalizeTarget(value: string): PlatformTarget {
  if (value === 'android' || value === 'ios' || value === 'ait') {
    return value;
  }

  return 'browser';
}
