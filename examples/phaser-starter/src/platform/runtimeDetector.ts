import type { PlatformTarget } from '@mpgd/platform';

export interface RuntimeConfig {
  readonly target: PlatformTarget;
  readonly configTarget: string;
  readonly appVersion: string;
  readonly buildId: string;
  readonly debug: boolean;
}

export function detectRuntime(): RuntimeConfig {
  const target = normalizeTarget(__APP_TARGET__);

  return {
    target,
    configTarget: normalizeConfigTarget(__MPGD_CONFIG_TARGET__, target),
    appVersion: __APP_VERSION__,
    buildId: __BUILD_ID__,
    debug: __DEBUG_BUILD__,
  };
}

export function normalizeTarget(value: string): PlatformTarget {
  if (value === 'android' || value === 'ios' || value === 'ait' || value === 'reddit') {
    return value;
  }

  return 'browser';
}

export function normalizeConfigTarget(value: string, target: PlatformTarget): string {
  return value.length > 0 ? value : target === 'browser' ? 'web-preview' : target;
}
