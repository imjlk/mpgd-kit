import type { MiniGameCanvasElement } from './canvas.js';
import { MiniGameEvent } from './events.js';
import type { MiniGameHost, MiniGameTouch } from './host.js';

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

  try {
    unsubscribers.push(host.onTouchStart((touches) => {
      const changed = touches.map((touch) => createTouchPoint(touch, canvas));

      for (const touch of changed) {
        activeTouches.set(touch.identifier, touch);
      }

      dispatch('touchstart', changed);
    }));
    unsubscribers.push(host.onTouchMove((touches) => {
      const changed = touches.map((touch) => createTouchPoint(touch, canvas));

      for (const touch of changed) {
        activeTouches.set(touch.identifier, touch);
      }

      dispatch('touchmove', changed);
    }));
    unsubscribers.push(host.onTouchEnd((touches) => {
      const changed = touches.map((touch) => createTouchPoint(touch, canvas));

      for (const touch of changed) {
        activeTouches.delete(touch.identifier);
      }

      dispatch('touchend', changed);
    }));
    unsubscribers.push(host.onTouchCancel((touches) => {
      const changed = touches.map((touch) => createTouchPoint(touch, canvas));

      for (const touch of changed) {
        activeTouches.delete(touch.identifier);
      }

      dispatch('touchcancel', changed);
    }));
  } catch (error) {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }

    throw error;
  }

  let disposed = false;

  return {
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      activeTouches.clear();

      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
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
