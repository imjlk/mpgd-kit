import type { MiniGameCanvasElement } from './canvas.js';
import { MiniGameEvent } from './events.js';
import { MiniGameRuntimeError, type MiniGameHost, type MiniGameTouch } from './host.js';

export interface MiniGameTouchPoint extends MiniGameTouch {
  readonly target: MiniGameCanvasElement;
  readonly pageX: number;
  readonly pageY: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly rotationAngle: number;
  readonly force: number;
}

export class MiniGameTouchEvent extends MiniGameEvent {
  readonly touches: readonly MiniGameTouchPoint[];
  readonly targetTouches: readonly MiniGameTouchPoint[];
  readonly changedTouches: readonly MiniGameTouchPoint[];
  readonly altKey = false;
  readonly ctrlKey = false;
  readonly metaKey = false;
  readonly shiftKey = false;

  constructor(
    type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
    touches: readonly MiniGameTouchPoint[],
    changedTouches: readonly MiniGameTouchPoint[],
  ) {
    super(type, { cancelable: true });
    this.touches = touches;
    this.targetTouches = touches;
    this.changedTouches = changedTouches;
  }
}

export interface MiniGameInputInstallation {
  dispose(): void;
}

export function installMiniGameTouchInput(
  host: MiniGameHost,
  canvas: MiniGameCanvasElement,
): MiniGameInputInstallation {
  const activeTouches = new Map<number, MiniGameTouchPoint>();
  const unsubscribers: Array<() => void> = [];
  let active = true;

  try {
    unsubscribers.push(assertTouchUnsubscribe(host.onTouchStart((touches) => {
      if (!active) {
        return;
      }

      const changed = touches.map((touch) => createTouchPoint(touch, canvas));

      for (const touch of changed) {
        activeTouches.set(touch.identifier, touch);
      }

      dispatch('touchstart', changed);
    }), 'onTouchStart'));
    unsubscribers.push(assertTouchUnsubscribe(host.onTouchMove((touches) => {
      if (!active) {
        return;
      }

      const changed = touches.map((touch) => createTouchPoint(touch, canvas));

      for (const touch of changed) {
        activeTouches.set(touch.identifier, touch);
      }

      dispatch('touchmove', changed);
    }), 'onTouchMove'));
    unsubscribers.push(assertTouchUnsubscribe(host.onTouchEnd((touches) => {
      if (!active) {
        return;
      }

      const changed = touches.map((touch) => createTouchPoint(touch, canvas));

      for (const touch of changed) {
        activeTouches.delete(touch.identifier);
      }

      dispatch('touchend', changed);
    }), 'onTouchEnd'));
    unsubscribers.push(assertTouchUnsubscribe(host.onTouchCancel((touches) => {
      if (!active) {
        return;
      }

      const changed = touches.map((touch) => createTouchPoint(touch, canvas));

      for (const touch of changed) {
        activeTouches.delete(touch.identifier);
      }

      dispatch('touchcancel', changed);
    }), 'onTouchCancel'));
  } catch (error) {
    active = false;
    runTouchUnsubscribers(unsubscribers);

    throw error;
  }

  let disposed = false;

  return {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      active = false;
      activeTouches.clear();
      runTouchUnsubscribers(unsubscribers);
    },
  };

  function dispatch(
    type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
    changedTouches: readonly MiniGameTouchPoint[],
  ): void {
    const event = new MiniGameTouchEvent(type, [...activeTouches.values()], changedTouches);
    canvas.dispatchEvent(event);
  }
}

function assertTouchUnsubscribe(input: unknown, source: string): () => void {
  if (typeof input !== 'function') {
    throw new MiniGameRuntimeError(
      'MINIGAME_INVALID_TOUCH_SUBSCRIPTION',
      `Mini-game host ${source} must return an unsubscribe function.`,
    );
  }

  return input as () => void;
}

function runTouchUnsubscribers(unsubscribers: readonly (() => void)[]): void {
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      try {
        console.error('Mini-game touch unsubscription failed; cleanup continues.', error);
      } catch {
        // Cleanup must continue even when host logging is unavailable.
      }
    }
  }
}

function createTouchPoint(
  touch: MiniGameTouch,
  canvas: MiniGameCanvasElement,
): MiniGameTouchPoint {
  return {
    ...touch,
    target: canvas,
    pageX: touch.clientX,
    pageY: touch.clientY,
    screenX: touch.clientX,
    screenY: touch.clientY,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  };
}
