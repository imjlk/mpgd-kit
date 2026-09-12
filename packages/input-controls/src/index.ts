/**
 * Headless virtual joystick state core.
 *
 * The controller consumes pointer IDs and plain coordinates only. It never
 * imports or references DOM `PointerEvent`s, engine pointer objects, or
 * mini-game SDK objects, so the same core can be wired from a browser canvas,
 * a Phaser input plugin, or a native mini-game touch handler. Where a touch
 * may begin, pointer capture, event listening, rendering, safe-area layout,
 * and how the resulting direction drives character motion are all consumer
 * responsibilities.
 *
 * Coordinate contract: every point is expressed in one coordinate system of
 * the caller's choosing (for example viewport `clientX`/`clientY` or canvas
 * local coordinates), and the same system must be used for the whole gesture.
 * The core performs no viewport or DPI conversion and never guesses a
 * coordinate space.
 *
 * Quantization contract: directions are eight-way only. A snapshot direction
 * is one of the eight compass unit vectors or `center` — it is not a
 * continuous analog angle. Diagonal vectors are normalized by
 * `Math.SQRT1_2` so diagonal movement is never faster than axial movement.
 */

/** The nine quantized direction states of the eight-way joystick. */
export type DynamicJoystickDirectionId =
  | 'center'
  | 'east'
  | 'south-east'
  | 'south'
  | 'south-west'
  | 'west'
  | 'north-west'
  | 'north'
  | 'north-east';

export interface DynamicJoystickPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A frozen, shared direction value. Diagonal components use `Math.SQRT1_2`
 * so the vector length is one on every spoke.
 */
export interface DynamicJoystickDirection {
  readonly id: DynamicJoystickDirectionId;
  readonly x: number;
  readonly y: number;
}

/**
 * Frozen, self-contained view of the joystick state. Snapshots are immutable:
 * mutating one throws in strict mode and can never alter the controller.
 */
export interface DynamicJoystickSnapshot {
  readonly active: boolean;
  readonly deadZone: number;
  readonly direction: DynamicJoystickDirection;
  /** Raw pointer distance from the origin; it can exceed the visual radius. */
  readonly distance: number;
  /** Dead-zone-adjusted movement intensity in the inclusive range from zero to one. */
  readonly force: number;
  /** Visual handle position: the pointer projected onto the visual radius circle. */
  readonly handle: DynamicJoystickPoint | null;
  /** Anchor point of the active gesture; the position where the touch began. */
  readonly origin: DynamicJoystickPoint | null;
  /** Pointer ID that owns the active gesture, or null when inactive. */
  readonly pointerId: number | null;
  readonly radius: number;
  /**
   * Monotonic counter that increments on every state-changing operation and
   * stays unchanged on no-op calls, so consumers can detect updates without
   * deep-comparing snapshots.
   */
  readonly sequence: number;
}

export interface DynamicJoystickOptions {
  /** Distance at or below which input reads as center with zero force. Defaults to 18. */
  readonly deadZone?: number;
  /** Visual handle radius. Defaults to 64. */
  readonly radius?: number;
}

export interface DynamicJoystickController {
  /**
   * Claim the first free pointer at `point`, making it the gesture origin.
   * A no-op returning the current snapshot while another pointer is active.
   */
  readonly begin: (
    pointerId: number,
    point: DynamicJoystickPoint,
  ) => DynamicJoystickSnapshot;
  /** Explicitly clear the active gesture. Safe (and inert) when inactive. */
  readonly cancel: () => DynamicJoystickSnapshot;
  /**
   * End the gesture, but only when `pointerId` owns it; other pointers'
   * ends never release an active gesture.
   */
  readonly end: (pointerId: number) => DynamicJoystickSnapshot;
  /** The latest frozen snapshot; the same reference until state changes. */
  readonly getSnapshot: () => DynamicJoystickSnapshot;
  /**
   * Move the owning pointer. Moves from any other pointer are no-ops that
   * return the current snapshot untouched.
   */
  readonly move: (
    pointerId: number,
    point: DynamicJoystickPoint,
  ) => DynamicJoystickSnapshot;
}

const defaultRadius = 64;
const defaultDeadZone = 18;
const diagonalAxis = Math.SQRT1_2;
const centerDirection = Object.freeze({
  id: 'center',
  x: 0,
  y: 0,
} as const satisfies DynamicJoystickDirection);
const eightWayDirections = Object.freeze([
  Object.freeze({ id: 'east', x: 1, y: 0 }),
  Object.freeze({ id: 'south-east', x: diagonalAxis, y: diagonalAxis }),
  Object.freeze({ id: 'south', x: 0, y: 1 }),
  Object.freeze({ id: 'south-west', x: -diagonalAxis, y: diagonalAxis }),
  Object.freeze({ id: 'west', x: -1, y: 0 }),
  Object.freeze({ id: 'north-west', x: -diagonalAxis, y: -diagonalAxis }),
  Object.freeze({ id: 'north', x: 0, y: -1 }),
  Object.freeze({ id: 'north-east', x: diagonalAxis, y: -diagonalAxis }),
] as const satisfies readonly DynamicJoystickDirection[]);

/**
 * Create a dynamic virtual joystick anchored wherever the owning touch
 * begins. Exactly one pointer is owned at a time: the first `begin` claims
 * the gesture, and every operation from another pointer is an inert no-op
 * until the owner ends, the gesture is canceled, or the controller is
 * cleared. The next `begin` anchors a fresh origin at its own touch point.
 */
export function createDynamicJoystick(
  options: DynamicJoystickOptions = {},
): DynamicJoystickController {
  const radius = options.radius ?? defaultRadius;
  const deadZone = options.deadZone ?? defaultDeadZone;
  validateGeometry(radius, deadZone);
  let sequence = 0;
  let snapshot = createInactiveSnapshot(radius, deadZone, sequence);

  return {
    begin(pointerId, point) {
      validatePointerId(pointerId);
      validatePoint(point);

      if (snapshot.active) {
        return snapshot;
      }

      sequence += 1;
      const origin = copyPoint(point);
      snapshot = Object.freeze({
        active: true,
        deadZone,
        direction: centerDirection,
        distance: 0,
        force: 0,
        handle: origin,
        origin,
        pointerId,
        radius,
        sequence,
      });
      return snapshot;
    },
    cancel() {
      if (!snapshot.active) {
        return snapshot;
      }

      sequence += 1;
      snapshot = createInactiveSnapshot(radius, deadZone, sequence);
      return snapshot;
    },
    end(pointerId) {
      validatePointerId(pointerId);

      if (!snapshot.active || snapshot.pointerId !== pointerId) {
        return snapshot;
      }

      sequence += 1;
      snapshot = createInactiveSnapshot(radius, deadZone, sequence);
      return snapshot;
    },
    getSnapshot() {
      return snapshot;
    },
    move(pointerId, point) {
      validatePointerId(pointerId);
      validatePoint(point);

      if (
        !snapshot.active
        || snapshot.pointerId !== pointerId
        || snapshot.origin === null
      ) {
        return snapshot;
      }

      const axisX = point.x - snapshot.origin.x;
      const axisY = point.y - snapshot.origin.y;

      // Both endpoints are finite, but coordinates near opposite ends of the
      // double-precision range can overflow their difference or magnitude;
      // every snapshot field must stay finite, so such gestures are rejected
      // before any state change instead of silently producing Infinity or NaN.
      assertFinite('point.x delta', axisX);
      assertFinite('point.y delta', axisY);
      const distance = Math.hypot(axisX, axisY);
      assertFinite('distance', distance);
      const clampedDistance = Math.min(distance, radius);
      const unitX = distance > 0 ? axisX / distance : 0;
      const unitY = distance > 0 ? axisY / distance : 0;
      const force = distance <= deadZone
        ? 0
        : Math.min(1, (distance - deadZone) / (radius - deadZone));
      sequence += 1;
      snapshot = Object.freeze({
        active: true,
        deadZone,
        direction: quantizeEightWayDirection(axisX, axisY, deadZone),
        distance,
        force,
        handle: Object.freeze({
          x: snapshot.origin.x + unitX * clampedDistance,
          y: snapshot.origin.y + unitY * clampedDistance,
        }),
        origin: snapshot.origin,
        pointerId,
        radius,
        sequence,
      });
      return snapshot;
    },
  };
}

/**
 * Quantize a raw axis vector to one of eight compass directions (or center
 * inside the dead zone). Sector boundaries sit every 45° starting from east;
 * with screen coordinates (positive y is south) positive angles rotate
 * clockwise, an exact +22.5° tie resolves toward the south-east neighbor
 * while an exact -22.5° tie stays on east, matching `Math.round`, and
 * negative angles wrap through the modulo into the same eight sectors. The
 * result is a shared frozen object — treat it as read-only.
 */
export function quantizeEightWayDirection(
  axisX: number,
  axisY: number,
  deadZone = 0,
): DynamicJoystickDirection {
  assertFinite('axisX', axisX);
  assertFinite('axisY', axisY);
  assertFinite('deadZone', deadZone);

  if (deadZone < 0) {
    throw new RangeError('Dynamic joystick deadZone must not be negative.');
  }

  const magnitude = Math.hypot(axisX, axisY);
  assertFinite('axis magnitude', magnitude);

  if (magnitude <= deadZone) {
    return centerDirection;
  }

  const rawSector = Math.round(Math.atan2(axisY, axisX) / (Math.PI / 4));
  const sector = (rawSector % eightWayDirections.length + eightWayDirections.length)
    % eightWayDirections.length;
  return eightWayDirections[sector] ?? centerDirection;
}

function createInactiveSnapshot(
  radius: number,
  deadZone: number,
  sequence: number,
): DynamicJoystickSnapshot {
  return Object.freeze({
    active: false,
    deadZone,
    direction: centerDirection,
    distance: 0,
    force: 0,
    handle: null,
    origin: null,
    pointerId: null,
    radius,
    sequence,
  });
}

function copyPoint(point: DynamicJoystickPoint): DynamicJoystickPoint {
  return Object.freeze({ x: point.x, y: point.y });
}

function validateGeometry(radius: number, deadZone: number): void {
  assertFinite('radius', radius);
  assertFinite('deadZone', deadZone);

  if (radius <= 0) {
    throw new RangeError('Dynamic joystick radius must be greater than zero.');
  }

  if (deadZone < 0 || deadZone >= radius) {
    throw new RangeError('Dynamic joystick deadZone must be between zero and radius.');
  }
}

function validatePointerId(pointerId: number): void {
  if (!Number.isSafeInteger(pointerId) || pointerId < 0) {
    throw new TypeError('Dynamic joystick pointerId must be a non-negative safe integer.');
  }
}

function validatePoint(point: DynamicJoystickPoint): void {
  assertFinite('point.x', point.x);
  assertFinite('point.y', point.y);
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Dynamic joystick ${name} must be finite.`);
  }
}
