import { describe, expect, it } from 'vitest';

import {
  createDynamicJoystick,
  quantizeEightWayDirection,
  type DynamicJoystickController,
} from './joystick';

const halfSectorSlope = Math.tan(Math.PI / 8);

describe('dynamic virtual joystick', () => {
  // 1. The eight directions and center are returned exactly.
  it.each([
    [100, 0, 'east'],
    [100, 100, 'south-east'],
    [0, 100, 'south'],
    [-100, 100, 'south-west'],
    [-100, 0, 'west'],
    [-100, -100, 'north-west'],
    [0, -100, 'north'],
    [100, -100, 'north-east'],
  ] as const)('quantizes (%s, %s) to %s', (axisX, axisY, expected) => {
    expect(quantizeEightWayDirection(axisX, axisY).id).toBe(expected);
  });

  it('reports center inside the dead zone and unit-length spokes', () => {
    expect(quantizeEightWayDirection(3, 4, 10).id).toBe('center');
    for (const direction of [
      quantizeEightWayDirection(0, -50),
      quantizeEightWayDirection(50, 50),
      quantizeEightWayDirection(-50, 50),
    ]) {
      expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 12);
    }
  });

  // 2. Sector boundaries and negative angles stay consistent.
  it('resolves boundary ties and wraps negative angles', () => {
    expect(quantizeEightWayDirection(1, halfSectorSlope).id).toBe('south-east');
    expect(quantizeEightWayDirection(1, -halfSectorSlope).id).toBe('east');
    expect(quantizeEightWayDirection(1, -0.42).id).toBe('north-east');
    expect(quantizeEightWayDirection(1, -1).id).toBe('north-east');
    expect(quantizeEightWayDirection(0, -1).id).toBe('north');
    expect(quantizeEightWayDirection(-1, -1).id).toBe('north-west');
    expect(quantizeEightWayDirection(-1, 0).id).toBe('west');
    expect(quantizeEightWayDirection(-1, -0).id).toBe('west');
  });

  // 3. Dead zone interior, boundary, and just past the boundary.
  it('maps force through the dead zone', () => {
    const joystick = createDynamicJoystick({ deadZone: 20, radius: 60 });
    joystick.begin(3, { x: 0, y: 0 });

    const interior = joystick.move(3, { x: 19, y: 0 });
    expect(interior.force).toBe(0);
    expect(interior.direction.id).toBe('center');

    const boundary = joystick.move(3, { x: 20, y: 0 });
    expect(boundary.force).toBe(0);
    expect(boundary.direction.id).toBe('center');

    const justPast = joystick.move(3, { x: 21, y: 0 });
    expect(justPast.force).toBeCloseTo(1 / 40, 12);
    expect(justPast.direction.id).toBe('east');

    const atRadius = joystick.move(3, { x: 60, y: 0 });
    expect(atRadius.force).toBe(1);

    const beyondRadius = joystick.move(3, { x: 220, y: 0 });
    expect(beyondRadius.force).toBe(1);
  });

  // 4. Beyond the radius the handle clamps while the distance stays raw.
  it('clamps the visual handle and preserves the raw distance', () => {
    const joystick = createDynamicJoystick({ radius: 60 });
    joystick.begin(3, { x: 100, y: 200 });

    const east = joystick.move(3, { x: 220, y: 200 });
    expect(east.distance).toBe(120);
    expect(east.handle).toEqual({ x: 160, y: 200 });

    const diagonal = joystick.move(3, { x: 400, y: 500 });
    expect(diagonal.distance).toBeCloseTo(Math.hypot(300, 300), 9);
    expect(diagonal.handle?.x).toBeCloseTo(100 + 60 * Math.SQRT1_2, 9);
    expect(diagonal.handle?.y).toBeCloseTo(200 + 60 * Math.SQRT1_2, 9);
  });

  // 5. A second pointer cannot hijack the active gesture.
  it('owns exactly one pointer', () => {
    const joystick = createDynamicJoystick({ deadZone: 20, radius: 60 });
    const began = joystick.begin(3, { x: 100, y: 200 });

    expect(joystick.begin(4, { x: 400, y: 500 })).toBe(began);
    expect(joystick.move(4, { x: 450, y: 500 })).toBe(began);
    expect(joystick.move(3, { x: 121, y: 200 }).force).toBeCloseTo(1 / 40, 12);
  });

  // 6. Another pointer's end never releases the gesture.
  it('ends only for the owning pointer', () => {
    const joystick = createDynamicJoystick();
    joystick.begin(1, { x: 40, y: 50 });
    joystick.move(1, { x: 90, y: 50 });

    expect(joystick.end(2).active).toBe(true);
    expect(joystick.getSnapshot().active).toBe(true);
  });

  // 7. End and cancel reset every movement field.
  it('clears state on release and cancellation', () => {
    const released = createDynamicJoystick();
    released.begin(1, { x: 40, y: 50 });
    released.move(1, { x: 90, y: 50 });

    expect(released.end(1)).toMatchObject({
      active: false,
      direction: { id: 'center', x: 0, y: 0 },
      distance: 0,
      force: 0,
      handle: null,
      origin: null,
      pointerId: null,
    });

    const canceled = createDynamicJoystick();
    canceled.begin(1, { x: 40, y: 50 });
    canceled.move(1, { x: 90, y: 50 });

    expect(canceled.cancel()).toMatchObject({
      active: false,
      direction: { id: 'center' },
      force: 0,
      handle: null,
      origin: null,
      pointerId: null,
    });
  });

  // 8. A restarted gesture anchors at its new touch point.
  it('anchors the next touch at a fresh origin', () => {
    const joystick = createDynamicJoystick();
    joystick.begin(1, { x: 40, y: 50 });
    joystick.move(1, { x: 90, y: 50 });
    joystick.end(1);

    const restarted = joystick.begin(7, { x: 300, y: 420 });
    expect(restarted.origin).toEqual({ x: 300, y: 420 });
    expect(restarted.direction.id).toBe('center');
    expect(restarted.force).toBe(0);

    const moved = joystick.move(7, { x: 360, y: 420 });
    expect(moved.direction.id).toBe('east');
    expect(moved.distance).toBe(60);
  });

  // 9. Invalid coordinates, pointer IDs, geometry, and overflow are rejected.
  it('rejects invalid geometry, pointer ids, coordinates, and overflow', () => {
    expect(() => createDynamicJoystick({ deadZone: 20, radius: 20 })).toThrow(/deadZone/u);
    expect(() => createDynamicJoystick({ radius: 0 })).toThrow(/radius/u);
    expect(() => createDynamicJoystick({ radius: Number.NaN })).toThrow(/radius/u);

    const joystick = createDynamicJoystick();
    expect(() => joystick.begin(-1, { x: 0, y: 0 })).toThrow(/pointerId/u);
    expect(() => joystick.begin(1.5, { x: 0, y: 0 })).toThrow(/pointerId/u);
    expect(() => joystick.begin(Number.NaN, { x: 0, y: 0 })).toThrow(/pointerId/u);
    expect(() => joystick.begin(1, { x: Number.NaN, y: 0 })).toThrow(/point\.x/u);
    expect(() => joystick.begin(1, { x: 0, y: Number.POSITIVE_INFINITY })).toThrow(/point\.y/u);

    const overflow = createDynamicJoystick();
    overflow.begin(9, { x: -Number.MAX_VALUE, y: 0 });
    const before = overflow.getSnapshot();
    expect(() =>
      overflow.move(9, { x: Number.MAX_VALUE, y: 0 })).toThrow(/delta|finite/u);
    expect(overflow.getSnapshot()).toBe(before);
  });

  // 10. Mutating a returned snapshot cannot corrupt the controller.
  it('keeps snapshots frozen', () => {
    const joystick = createDynamicJoystick({ radius: 60 });
    const began = joystick.begin(3, { x: 100, y: 200 });
    const moved = joystick.move(3, { x: 130, y: 220 });

    expect(Object.isFrozen(began)).toBe(true);
    expect(Object.isFrozen(moved)).toBe(true);
    expect(Object.isFrozen(moved.handle)).toBe(true);
    expect(Object.isFrozen(moved.direction)).toBe(true);
    expect(Object.isFrozen(moved.origin)).toBe(true);
    expect(() => {
      (moved as { force: number }).force = 0.5;
    }).toThrow();
    expect(() => {
      (moved.handle as { x: number }).x = 0;
    }).toThrow();
    expect(joystick.getSnapshot().force).toBe(moved.force);
  });

  // 11. Sequence increments exactly on state changes and never on no-ops.
  it('tracks the sequence across operations and repeated cancels', () => {
    const joystick = createDynamicJoystick();
    expect(joystick.getSnapshot().sequence).toBe(0);

    expect(joystick.begin(3, { x: 0, y: 0 }).sequence).toBe(1);
    expect(joystick.begin(4, { x: 90, y: 90 }).sequence).toBe(1);
    expect(joystick.move(4, { x: 90, y: 90 }).sequence).toBe(1);
    expect(joystick.move(3, { x: 30, y: 0 }).sequence).toBe(2);
    expect(joystick.end(4).sequence).toBe(2);
    expect(joystick.end(3).sequence).toBe(3);
    expect(joystick.cancel().sequence).toBe(3);
    expect(joystick.cancel().sequence).toBe(3);
    expect(joystick.cancel().sequence).toBe(3);
    expect(joystick.getSnapshot().sequence).toBe(3);
    expect(joystick.begin(5, { x: 10, y: 10 }).sequence).toBe(4);
  });

  // 12. The browser wiring fixture zeroes movement on cancel, blur, and teardown.
  it('clears movement through the documented browser wiring', () => {
    for (const teardownTrigger of ['pointercancel', 'lostpointercapture', 'blur', 'teardown'] as const) {
      const joystick = createDynamicJoystick({ deadZone: 10, radius: 50 });
      const binding = createBrowserJoystickFixture(joystick);

      binding.dispatch({ clientX: 100, clientY: 100, pointerId: 3, type: 'pointerdown' });
      binding.dispatch({ clientX: 150, clientY: 100, pointerId: 3, type: 'pointermove' });
      expect(joystick.getSnapshot().force).toBe(1);

      // An unrelated pointer's cancel must not drop the active gesture.
      binding.dispatch({ pointerId: 8, type: 'pointercancel' });
      expect(joystick.getSnapshot().active).toBe(true);

      if (teardownTrigger === 'pointercancel' || teardownTrigger === 'lostpointercapture') {
        binding.dispatch({ pointerId: 3, type: teardownTrigger });
      } else if (teardownTrigger === 'blur') {
        binding.dispatch({ type: 'blur' });
      } else {
        binding.teardown();
      }

      expect(joystick.getSnapshot()).toMatchObject({
        active: false,
        direction: { id: 'center' },
        force: 0,
        handle: null,
        origin: null,
        pointerId: null,
      });

      if (teardownTrigger === 'teardown') {
        binding.dispatch({ clientX: 100, clientY: 100, pointerId: 3, type: 'pointerdown' });
        expect(joystick.getSnapshot().active).toBe(false);
      }
    }
  });

  // 13. The core imports and runs with no DOM or engine globals.
  it('runs headless', () => {
    expect(typeof globalThis.document).toBe('undefined');
    expect(typeof globalThis.window).toBe('undefined');

    const joystick = createDynamicJoystick();
    joystick.begin(1, { x: 0, y: 0 });
    joystick.move(1, { x: 70, y: 0 });
    expect(joystick.getSnapshot().direction.id).toBe('east');
    joystick.cancel();
    expect(joystick.getSnapshot().active).toBe(false);
  });
});

/**
 * Integration fixture for the browser wiring documented in
 * docs/GAME_JOYSTICK_INPUT.md: begin on pointerdown, move on pointermove,
 * end on pointerup, cancel on the owning pointer's pointercancel or
 * lostpointercapture and on blur, and detach everything on teardown. It
 * listens on one element (no global listeners) and ignores unrelated
 * pointers for every event type.
 */
function createBrowserJoystickFixture(joystick: DynamicJoystickController) {
  const listeners = new Map<string, Set<(event: FixturePointerEvent) => void>>();

  const on = (
    type: string,
    listener: (event: FixturePointerEvent) => void,
  ): void => {
    const existing = listeners.get(type) ?? new Set();
    existing.add(listener);
    listeners.set(type, existing);
  };
  const off = (
    type: string,
    listener: (event: FixturePointerEvent) => void,
  ): void => {
    listeners.get(type)?.delete(listener);
  };

  const pointerDown = (event: FixturePointerEvent): void => {
    if (event.pointerId === undefined || event.clientX === undefined || event.clientY === undefined) {
      return;
    }
    if (!joystick.getSnapshot().active) {
      joystick.begin(event.pointerId, { x: event.clientX, y: event.clientY });
    }
  };
  const pointerMove = (event: FixturePointerEvent): void => {
    if (event.pointerId === undefined || event.clientX === undefined || event.clientY === undefined) {
      return;
    }
    joystick.move(event.pointerId, { x: event.clientX, y: event.clientY });
  };
  const pointerUp = (event: FixturePointerEvent): void => {
    if (event.pointerId === undefined) {
      return;
    }
    joystick.end(event.pointerId);
  };
  const cancelIfOwned = (event: FixturePointerEvent): void => {
    const snapshot = joystick.getSnapshot();

    if (snapshot.active && event.pointerId === snapshot.pointerId) {
      joystick.cancel();
    }
  };
  const onBlur = (): void => {
    joystick.cancel();
  };

  const registered: [string, (event: FixturePointerEvent) => void][] = [];

  for (const type of [
    'pointerdown',
    'pointermove',
    'pointerup',
    'pointercancel',
    'lostpointercapture',
    'blur',
  ] as const) {
    const listener = type === 'pointerdown'
      ? pointerDown
      : type === 'pointermove'
        ? pointerMove
        : type === 'pointerup'
          ? pointerUp
          : type === 'blur'
            ? onBlur
            : cancelIfOwned;
    on(type, listener);
    registered.push([type, listener]);
  }

  return {
    dispatch(event: FixturePointerEvent): void {
      for (const listener of [...(listeners.get(event.type) ?? [])]) {
        listener(event);
      }
    },
    teardown(): void {
      for (const [type, listener] of registered) {
        off(type, listener);
      }
      joystick.cancel();
    },
  };
}

interface FixturePointerEvent {
  readonly clientX?: number;
  readonly clientY?: number;
  readonly pointerId?: number;
  readonly type: string;
}
