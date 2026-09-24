import { describe, expect, it, vi } from 'vitest';
import { resolveTargetViewportUsableArea } from '@mpgd/target-config';

import { createCapacitorPlatformGateway } from './index.js';
import { createCapacitorViewport, type CapacitorViewportHost } from './viewport.js';

const zero = { top: 0, right: 0, bottom: 0, left: 0 };

function fixture() {
  let state = {
    width: 390,
    height: 844,
    safeAreaInsets: { top: 24, right: 0, bottom: 34, left: 0 },
    systemBarInsets: { top: 30, right: 0, bottom: 24, left: 0 },
    keyboardInsets: zero,
  };
  const listeners = new Set<() => void>();
  const host: CapacitorViewportHost = {
    readState: () => state,
    onChange(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  return {
    host,
    listeners,
    update(next: Partial<typeof state>) {
      state = { ...state, ...next };
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

describe('Capacitor viewport', () => {
  it('owns one host listener and emits only changed states', () => {
    const host = fixture();
    const viewport = createCapacitorViewport({ host: host.host });
    const updates: number[] = [];
    const offFirst = viewport.onChange((state) => { updates.push(state.height); });
    const offSecond = viewport.onChange((state) => { updates.push(state.height); });
    expect(host.listeners.size).toBe(1);
    host.update({});
    expect(updates).toEqual([]);
    host.update({ height: 390, width: 844 });
    expect(updates).toEqual([390, 390]);
    offFirst();
    offFirst();
    expect(host.listeners.size).toBe(1);
    offSecond();
    expect(host.listeners.size).toBe(0);
    viewport.dispose();
    viewport.dispose();
    expect(() => viewport.getState()).toThrow(/disposed/u);
  });

  it('keeps delivering after a subscriber and its error reporter both throw', () => {
    const host = fixture();
    const viewport = createCapacitorViewport({
      host: host.host,
      onError: () => { throw new Error('diagnostic failed'); },
    });
    const received: number[] = [];
    viewport.onChange(() => { throw new Error('subscriber failed'); });
    viewport.onChange((state) => { received.push(state.width); });
    expect(() => host.update({ width: 400 })).not.toThrow();
    expect(received).toEqual([400]);
    viewport.dispose();
  });

  it('tracks visual viewport top and root CSS inset changes without a resize', () => {
    const css = new Map<string, string>([['--safe-area-inset-top', '0px']]);
    const root = {};
    let observerCallback: (() => void) | undefined;
    let disconnected = false;
    class FakeMutationObserver {
      constructor(callback: () => void) { observerCallback = callback; }
      observe(target: unknown) { expect(target).toBe(root); }
      disconnect() { disconnected = true; }
    }
    const visual = {
      scale: 1, width: 390, height: 400, offsetTop: 200,
      addEventListener() {}, removeEventListener() {},
    };
    vi.stubGlobal('window', {
      innerWidth: 390, innerHeight: 800, visualViewport: visual,
      addEventListener() {}, removeEventListener() {},
    });
    vi.stubGlobal('document', { documentElement: root });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => css.get(name) ?? '',
    }));
    vi.stubGlobal('MutationObserver', FakeMutationObserver);
    try {
      const viewport = createCapacitorViewport();
      expect(viewport.getState().keyboardInsets)
        .toEqual({ top: 200, right: 0, bottom: 200, left: 0 });
      const received: number[] = [];
      const off = viewport.onChange((state) => { received.push(state.systemBarInsets.top); });
      css.set('--safe-area-inset-top', '42px');
      observerCallback?.();
      expect(received).toEqual([42]);
      off();
      expect(disconnected).toBe(true);
      viewport.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('converts provider-owned native pixels and shares one usable area', () => {
    const host = fixture();
    const viewport = createCapacitorViewport({ host: host.host });
    const updates: number[] = [];
    viewport.onChange((state) => { updates.push(state.occupiedSurfaces.length); });
    viewport.setOccupiedSurface({
      surfaceId: 'home-banner', edge: 'bottom', unit: 'physical-px',
      pixelsPerCssPixel: 3,
      bounds: { x: 0, y: 2_340, width: 1_170, height: 192 },
    });
    viewport.setOccupiedSurface({
      surfaceId: 'overlay', edge: 'bottom', unit: 'css-px',
      bounds: { x: 0, y: 800, width: 390, height: 44 },
    });
    const state = viewport.getState();
    expect(state.occupiedSurfaces[0]?.bounds).toEqual({ x: 0, y: 780, width: 390, height: 64 });
    expect(resolveTargetViewportUsableArea(state, state).contentBounds)
      .toEqual({ x: 0, y: 30, width: 390, height: 750 });
    host.update({ keyboardInsets: { ...zero, bottom: 290 } });
    expect(resolveTargetViewportUsableArea(viewport.getState(), viewport.getState()).contentBounds)
      .toEqual({ x: 0, y: 30, width: 390, height: 524 });
    viewport.clearOccupiedSurface('home-banner');
    viewport.clearOccupiedSurface('home-banner');
    expect(updates).toEqual([1, 2, 2, 1]);
    viewport.dispose();
    expect(host.listeners.size).toBe(0);
  });

  it('clips stale surfaces after rotation and rejects ambiguous native scales', () => {
    const host = fixture();
    const viewport = createCapacitorViewport({ host: host.host });
    expect(() => viewport.setOccupiedSurface({
      surfaceId: 'invalid-unit', edge: 'bottom', unit: 'other' as 'css-px',
      bounds: { x: 0, y: 0, width: 200, height: 30 },
    })).toThrow(/unit/u);
    expect(() => viewport.setOccupiedSurface({
      surfaceId: 'banner', edge: 'bottom', unit: 'physical-px',
      bounds: { x: 0, y: 0, width: 200, height: 30 },
    })).toThrow(/scale/u);
    viewport.setOccupiedSurface({
      surfaceId: 'banner', edge: 'bottom', unit: 'css-px',
      bounds: { x: 0, y: 780, width: 390, height: 64 },
    });
    host.update({ height: 390, width: 844 });
    expect(viewport.getState().occupiedSurfaces[0]?.bounds)
      .toEqual({ x: 0, y: 390, width: 390, height: 0 });
    expect(() => resolveTargetViewportUsableArea(viewport.getState(), viewport.getState()))
      .not.toThrow();
  });

  it('disposes only a gateway-owned viewport, not an injected one', async () => {
    const host = fixture();
    const injected = createCapacitorViewport({ host: host.host });
    const gateway = createCapacitorPlatformGateway({
      target: 'android', appVersion: '1.0.0', buildId: 'viewport-test', viewport: injected,
    });
    expect(gateway.viewport).toBe(injected);
    await gateway.lifecycle.dispose?.();
    expect(injected.getState().width).toBe(390);
    injected.dispose();

    const ownedGateway = createCapacitorPlatformGateway({
      target: 'ios', appVersion: '1.0.0', buildId: 'viewport-test',
    });
    await ownedGateway.lifecycle.dispose?.();
    expect(() => ownedGateway.viewport?.getState()).toThrow(/disposed/u);
  });
});
