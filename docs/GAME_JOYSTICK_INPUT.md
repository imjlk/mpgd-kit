# Headless Dynamic Joystick Input

`@mpgd/input-controls` provides `createDynamicJoystick()` and
`quantizeEightWayDirection()`: an eight-way virtual joystick state core that
consumes pointer IDs and plain coordinates. It is deliberately headless — the
same core can be wired from a browser canvas, a Phaser input plugin, or a
native mini-game touch handler.

## Responsibility split

The core owns:

- a dynamic joystick anchored wherever the owning touch begins;
- ownership of exactly one active pointer;
- the dead zone and the dead-zone-adjusted `force` in `[0, 1]`;
- clamping the visual handle to the configured radius;
- eight-way direction quantization with normalized diagonal vectors;
- explicit `end` and `cancel`, and a queryable frozen snapshot.

The consumer owns everything platform-facing: deciding where a touch may
begin, pointer capture and event listening, UI-button input-conflict policy,
rendering (CSS, canvas, or Phaser), safe-area layout, and translating the
snapshot into character speed, acceleration, or animation.

## Contract

- **Ownership**: the first `begin` claims the gesture. While active, another
  pointer's `begin`, `move`, or `end` is an inert no-op returning the current
  snapshot — nothing hijacks or releases the gesture but the owner's `end`,
  an explicit `cancel`, or teardown.
- **Cancel**: `cancel()` clears the active gesture and is safe to call
  repeatedly while inactive (a no-op that does not bump `sequence`).
- **Origins**: each `begin` anchors a fresh origin at its own touch point;
  the previous gesture's origin is never reused.
- **Geometry**: `distance` is the raw pointer distance from the origin and
  may exceed `radius`; `handle` is the pointer projected onto the visual
  radius circle and never exceeds it. `force` is
  `(distance - deadZone) / (radius - deadZone)` clamped to `[0, 1]`, and
  reads `0` at or inside the dead zone together with a `center` direction.
- **Eight-way only**: a snapshot direction is one of the eight compass unit
  vectors or `center` — it is not a continuous analog angle. Diagonal
  components are `Math.SQRT1_2`, so diagonal movement is never faster than
  axial movement. Sector ties at exactly +22.5° resolve toward the
  south-east spoke and at exactly -22.5° stay on east, matching
  `Math.round`; negative angles wrap through the modulo into the same
  sectors.
- **Coordinates**: pick one coordinate system (viewport `clientX`/`clientY`
  or canvas-local, for example) and use it for the whole gesture. The core
  performs no viewport or DPI conversion.
- **Sequence**: `sequence` increments exactly once per state-changing
  operation and never on no-op calls, so consumers can cheaply detect
  updates; `getSnapshot()` returns the same frozen reference until state
  changes.
- **Validation**: geometry (`radius > 0`, `0 <= deadZone < radius`), pointer
  IDs (non-negative safe integers), and finite coordinates are validated
  before any state change. Finite coordinates whose difference or magnitude
  overflows double precision are rejected with a `TypeError` rather than
  producing `Infinity` or `NaN` snapshots. Snapshots (and their `handle`,
  `origin`, and `direction` fields) are frozen; mutating them throws in
  strict mode and can never corrupt the controller.

## Browser wiring example

The example uses **viewport `clientX`/`clientY`** for both the start and the
moves, listens only on the joystick control area element (no document-level
listeners), and requests pointer capture when available so the owner's moves
keep arriving outside the element. When `setPointerCapture` is unavailable
(the mini-game adapters expose their own touch ownership), the same core
works unchanged: feed `begin`/`move`/`end` from the platform's touch
callbacks and keep the cancel triggers below.

```ts
import { createDynamicJoystick, type DynamicJoystickController } from '@mpgd/input-controls';

const joystick: DynamicJoystickController = createDynamicJoystick({
  deadZone: 18,
  radius: 64,
});

const area = document.querySelector<HTMLDivElement>('#joystick-area')!;

const onPointerDown = (event: PointerEvent): void => {
  area.setPointerCapture?.(event.pointerId); // optional; see note below
  if (!joystick.getSnapshot().active) {
    joystick.begin(event.pointerId, { x: event.clientX, y: event.clientY });
  }
};
const onPointerMove = (event: PointerEvent): void => {
  joystick.move(event.pointerId, { x: event.clientX, y: event.clientY });
};
const onPointerUp = (event: PointerEvent): void => {
  joystick.end(event.pointerId);
};
const onCancelIfOwned = (event: PointerEvent): void => {
  const snapshot = joystick.getSnapshot();
  if (snapshot.active && event.pointerId === snapshot.pointerId) {
    joystick.cancel();
  }
};
const onBlur = (): void => {
  joystick.cancel();
};

for (const [type, listener] of [
  ['pointerdown', onPointerDown],
  ['pointermove', onPointerMove],
  ['pointerup', onPointerUp],
  ['pointercancel', onCancelIfOwned],
  ['lostpointercapture', onCancelIfOwned],
] as const) {
  area.addEventListener(type, listener);
}
window.addEventListener('blur', onBlur);

// Each frame, read the frozen snapshot to drive movement.
// const { direction, force, active } = joystick.getSnapshot();

export function teardownJoystick(): void {
  for (const [type, listener] of [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerUp],
    ['pointercancel', onCancelIfOwned],
    ['lostpointercapture', onCancelIfOwned],
  ] as const) {
    area.removeEventListener(type, listener);
  }
  window.removeEventListener('blur', onBlur);
  joystick.cancel();
}
```

Notes:

- `pointercancel` and `lostpointercapture` cancel only for the **owning**
  pointer; unrelated pointers' events never drop the gesture. The core also
  ignores non-owner `move`/`end`, so extra listeners cannot disturb it.
- `blur` (or the platform's page-inactive callback) cancels unconditionally:
  the operating system took the touch away.
- Teardown removes every listener and cancels, so a suspended scene never
  reports stale movement.
- When pointer capture is unavailable, keep receiving moves from the
  platform's global touch handlers and forward them — the core's pointer
  ownership makes overshooting fingers harmless.
- Scope `touch-action`, `preventDefault`, and selection policy to the
  joystick area element only; do not add document-wide input policies.

The integration test in `packages/input-controls/src/index.test.ts` runs this
exact wiring headlessly against a structural event target, including
unrelated-pointer cancel events, `blur`, and teardown.

## Verification status

The core is verified by the headless vitest suite (quantization, boundaries,
dead zone, geometry, ownership, reset, validation, sequence, fixture,
headless import). It has **not** been verified on physical touch devices;
on-device validation belongs to the consuming game.
