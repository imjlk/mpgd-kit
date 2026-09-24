import type {
  PlatformViewportBounds,
  PlatformViewportOccupiedSurface,
  PlatformViewportState,
  ViewportAdapter,
} from '@mpgd/platform';
import { readTargetViewportSafeAreaInsets } from '@mpgd/target-config';

type ViewportBaseState = Omit<PlatformViewportState, 'occupiedSurfaces'>;

export interface CapacitorViewportHost {
  readState(): ViewportBaseState;
  onChange(callback: () => void): () => void;
}

export interface CapacitorOccupiedSurfaceInput extends PlatformViewportOccupiedSurface {
  /** Native providers report physical pixels with their own density scale. */
  readonly unit: 'css-px' | 'physical-px';
  readonly pixelsPerCssPixel?: number;
}

export interface CapacitorViewportController extends ViewportAdapter {
  setOccupiedSurface(input: CapacitorOccupiedSurfaceInput): void;
  clearOccupiedSurface(surfaceId: string): void;
  dispose(): void;
}

/**
 * Owns only its viewport listeners. CSS safe-area values are the default
 * system-inset source; a host can inject separate native system-bar readings
 * without summing the same occupied pixels twice.
 */
export function createCapacitorViewport(
  input: { readonly host?: CapacitorViewportHost; readonly onError?: (error: unknown) => void } = {},
): CapacitorViewportController {
  const host = input.host ?? createWebViewHost();
  const listeners = new Set<(state: PlatformViewportState) => void>();
  const surfaces = new Map<string, PlatformViewportOccupiedSurface>();
  let unsubscribeHost: (() => void) | undefined;
  let disposed = false;
  let lastState: PlatformViewportState | undefined;

  function getState(): PlatformViewportState {
    if (disposed) {
      throw new Error('Capacitor viewport is disposed.');
    }
    const base = host.readState();
    if (!Number.isFinite(base.width) || !Number.isFinite(base.height)
      || base.width <= 0 || base.height <= 0) {
      throw new Error('Capacitor viewport dimensions must be positive CSS pixels.');
    }
    const occupiedSurfaces = [...surfaces.values()].map((surface) => ({
      ...surface,
      bounds: clipBounds(surface.bounds, base.width, base.height),
    }));
    return {
      width: base.width,
      height: base.height,
      safeAreaInsets: { ...base.safeAreaInsets },
      systemBarInsets: { ...base.systemBarInsets },
      keyboardInsets: { ...base.keyboardInsets },
      occupiedSurfaces,
    };
  }

  function notify(): void {
    if (disposed) {
      return;
    }
    let state: PlatformViewportState;
    try {
      state = getState();
    } catch (error) {
      input.onError?.(error);
      return;
    }
    if (JSON.stringify(state) === JSON.stringify(lastState)) {
      return;
    }
    lastState = state;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        input.onError?.(error);
      }
    }
  }

  return {
    getState,
    onChange(callback) {
      if (disposed) {
        throw new Error('Capacitor viewport is disposed.');
      }
      listeners.add(callback);
      if (unsubscribeHost === undefined) {
        try {
          lastState = getState();
          unsubscribeHost = host.onChange(notify);
        } catch (error) {
          listeners.delete(callback);
          lastState = undefined;
          throw error;
        }
      }
      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(callback);
        if (listeners.size === 0) {
          unsubscribeHost?.();
          unsubscribeHost = undefined;
          lastState = undefined;
        }
      };
    },
    setOccupiedSurface(surface) {
      if (disposed) {
        throw new Error('Capacitor viewport is disposed.');
      }
      if (surface.surfaceId.trim() === '') {
        throw new Error('Occupied surface ID is required.');
      }
      if (!['top', 'right', 'bottom', 'left'].includes(surface.edge)) {
        throw new Error('Occupied surface edge is invalid.');
      }
      const scale = surface.unit === 'physical-px' ? surface.pixelsPerCssPixel : 1;
      if (scale === undefined || !Number.isFinite(scale) || scale <= 0) {
        throw new Error('Native occupied surfaces require a positive pixels-per-CSS-pixel scale.');
      }
      const { x, y, width, height } = surface.bounds;
      if (![x, y, width, height].every(Number.isFinite)
        || x < 0 || y < 0 || width < 0 || height < 0) {
        throw new Error('Occupied surface bounds must be non-negative finite pixels.');
      }
      surfaces.set(surface.surfaceId, {
        surfaceId: surface.surfaceId,
        edge: surface.edge,
        bounds: { x: x / scale, y: y / scale, width: width / scale, height: height / scale },
      });
      if (listeners.size > 0) {
        notify();
      }
    },
    clearOccupiedSurface(surfaceId) {
      if (disposed) {
        return;
      }
      if (surfaces.delete(surfaceId) && listeners.size > 0) {
        notify();
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeHost?.();
      unsubscribeHost = undefined;
      listeners.clear();
      surfaces.clear();
      lastState = undefined;
    },
  };
}

function clipBounds(bounds: PlatformViewportBounds, width: number, height: number): PlatformViewportBounds {
  const x = Math.max(0, Math.min(width, bounds.x));
  const y = Math.max(0, Math.min(height, bounds.y));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width - x, bounds.width)),
    height: Math.max(0, Math.min(height - y, bounds.height)),
  };
}

function createWebViewHost(): CapacitorViewportHost {
  const systemBarCssVariables = {
    top: '--safe-area-inset-top',
    right: '--safe-area-inset-right',
    bottom: '--safe-area-inset-bottom',
    left: '--safe-area-inset-left',
  };
  function readState(): ViewportBaseState {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('Capacitor viewport requires a WebView host.');
    }
    const width = Math.max(1, Math.round(window.innerWidth));
    const height = Math.max(1, Math.round(window.innerHeight));
    const visual = window.visualViewport;
    const style = getComputedStyle(document.documentElement);
    const keyboardBottom = visual !== null && visual !== undefined
      && visual.scale === 1 && visual.width >= width - 1
      ? Math.max(0, Math.round(height - visual.offsetTop - visual.height))
      : 0;
    return {
      width,
      height,
      safeAreaInsets: readTargetViewportSafeAreaInsets(style),
      systemBarInsets: readTargetViewportSafeAreaInsets(style, systemBarCssVariables),
      keyboardInsets: { top: 0, right: 0, bottom: keyboardBottom, left: 0 },
    };
  }

  return {
    readState,
    onChange(callback) {
      window.addEventListener('resize', callback);
      window.addEventListener('orientationchange', callback);
      const visual = window.visualViewport;
      visual?.addEventListener('resize', callback);
      visual?.addEventListener('scroll', callback);
      return () => {
        window.removeEventListener('resize', callback);
        window.removeEventListener('orientationchange', callback);
        visual?.removeEventListener('resize', callback);
        visual?.removeEventListener('scroll', callback);
      };
    },
  };
}
