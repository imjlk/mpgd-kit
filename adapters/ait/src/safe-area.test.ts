import { describe, expect, it, vi } from 'vitest';

import {
  aitSafeAreaCssVariables,
  installAitSafeAreaCssVariables,
  type AitSafeAreaCssStyle,
} from './safe-area';

class MemoryStyle implements AitSafeAreaCssStyle {
  readonly values = new Map<string, { readonly value: string; readonly priority: string }>();

  getPropertyValue(property: string): string {
    return this.values.get(property)?.value ?? '';
  }

  getPropertyPriority(property: string): string {
    return this.values.get(property)?.priority ?? '';
  }

  setProperty(property: string, value: string, priority = ''): void {
    this.values.set(property, { value, priority });
  }

  removeProperty(property: string): string {
    const previous = this.getPropertyValue(property);
    this.values.delete(property);
    return previous;
  }
}

describe('AIT safe-area CSS bridge', () => {
  it('publishes the initial native snapshot and follows host changes', () => {
    const style = new MemoryStyle();
    let onEvent: ((input: unknown) => void) | undefined;
    const unsubscribe = vi.fn();
    const dispose = installAitSafeAreaCssVariables({
      style,
      source: {
        get: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
        subscribe(input) {
          onEvent = input.onEvent;
          return unsubscribe;
        },
      },
    });

    expect(Object.fromEntries(
      [...style.values].map(([property, entry]) => [property, entry.value]),
    )).toEqual({
      '--mpgd-safe-area-top': '47px',
      '--mpgd-safe-area-right': '0px',
      '--mpgd-safe-area-bottom': '34px',
      '--mpgd-safe-area-left': '0px',
      '--mpgd-ait-navigation-control-top': '47px',
      '--mpgd-ait-navigation-control-right': '10px',
      '--mpgd-ait-navigation-content-top': '99px',
    });

    onEvent?.({ top: 59, right: 4, bottom: 21, left: 2 });
    expect(style.getPropertyValue(aitSafeAreaCssVariables.top)).toBe('59px');
    expect(style.getPropertyValue(aitSafeAreaCssVariables.navigationControlRight)).toBe('14px');
    expect(style.getPropertyValue(aitSafeAreaCssVariables.navigationContentTop)).toBe('111px');

    dispose();
    onEvent?.({ top: 70, right: 0, bottom: 0, left: 0 });
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(style.values.size).toBe(0);
  });

  it('keeps CSS fallbacks when native snapshots are unavailable or malformed', () => {
    const style = new MemoryStyle();
    style.setProperty(aitSafeAreaCssVariables.top, 'env(safe-area-inset-top)', 'important');
    let onEvent: ((input: unknown) => void) | undefined;
    const dispose = installAitSafeAreaCssVariables({
      style,
      source: {
        get() {
          throw new Error('native constant unavailable');
        },
        subscribe(input) {
          onEvent = input.onEvent;
          return () => {};
        },
      },
    });

    onEvent?.({ top: Number.NaN, right: 0, bottom: 0, left: 0 });
    onEvent?.({ top: 5_000, right: 0, bottom: 0, left: 0 });
    expect(style.getPropertyValue(aitSafeAreaCssVariables.top)).toBe(
      'env(safe-area-inset-top)',
    );
    expect(style.getPropertyPriority(aitSafeAreaCssVariables.top)).toBe('important');

    dispose();
    expect(style.getPropertyValue(aitSafeAreaCssVariables.top)).toBe(
      'env(safe-area-inset-top)',
    );
    expect(style.getPropertyPriority(aitSafeAreaCssVariables.top)).toBe('important');
  });

  it('is a no-op when rendered outside a browser', () => {
    expect(() => installAitSafeAreaCssVariables()()).not.toThrow();
  });

  it('restores CSS fallbacks even when the native unsubscribe throws', () => {
    const style = new MemoryStyle();
    style.setProperty(aitSafeAreaCssVariables.bottom, 'env(safe-area-inset-bottom)');
    const dispose = installAitSafeAreaCssVariables({
      style,
      source: {
        get: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
        subscribe: () => () => {
          throw new Error('native unsubscribe failed');
        },
      },
    });

    expect(() => dispose()).toThrow('native unsubscribe failed');
    expect(style.getPropertyValue(aitSafeAreaCssVariables.bottom)).toBe(
      'env(safe-area-inset-bottom)',
    );
  });
});
