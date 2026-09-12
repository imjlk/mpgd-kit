# Phaser game runtime (private preview)

`@mpgd/phaser-game-runtime` applies headless execution requests to one explicitly
selected gameplay scene. Keep pause/resume controls in a separate UI scene.
The adapter never pauses `Phaser.Game`, installs browser lifecycle listeners,
replaces scene methods, or grants purchases/rewards.

```ts
import { bindPhaserGameScene } from '@mpgd/phaser-game-runtime';

// Inside gameplayScene.create(); the binding also applies at the CREATE event,
// after SceneManager has finished initializing the scene's running status.
const binding = bindPhaserGameScene({
  controller: applicationRuntime,
  scene: gameplayScene,
  renderingPolicy: 'visibility',
  resetInput: () => { joystick.cancel(); pressedDirections.clear(); },
  audio: gameplayAudioSink,
  uiScope: gameplayViewScope,
  onUnsupportedState: (snapshot, reason) => showIntegrationError(reason),
  onError: reportError,
});
```

| Runtime request | Phaser mapping |
| --- | --- |
| Simulation + gameplay input blocked | `sys.pause()` on the selected running scene; render remains available |
| Input blocked, simulation allowed | Disable only this scene's pointer, keyboard and gamepad plugins; reset injected input state |
| Rendering blocked | `sys.setVisible(false)`, keeping simulation policy independent; no sleep/wake mapping |
| Audio blocked with a sink | Mute that explicit gameplay sink; no user volume changes or global sound manager calls |
| Simulation blocked, input allowed | Unsupported: required observer receives `simulation-requires-input-block`; previous engine controls remain intact |
| Audio blocked without a sink | Required observer receives `audio-sink-missing`; supported scene channels still apply |

Phaser's paused scenes cannot accept input even when the plugin `enabled` flag
is true. The core retains independent channels, but this binding cannot preserve
input during simulation pause. The required unsupported-state observer makes
this engine limitation explicit; it receives the requested snapshot and a safe
reason code. Each condition is reported once until it clears. Observation errors/rejected promises go to optional `onError`
without interrupting other cleanup. Its own failures are consumed.

`resetInput` must synchronously clear game-owned pressed keys, touch/joystick
ownership, and held actions. The binding does not guess a game's input model.
It runs when input blocking starts (and when a blocked scene wakes), preventing
missed key-up/touch-end events from replaying stale input after resume.

The sink exposes `getMuted()` and `setMuted(boolean)` for gameplay audio only.
A previously muted sink stays muted. The binding restores only mute changes it
owns; it never starts sounds, restores volume settings, fades, or resumes all audio.

## Ownership and lifetime

Use one execution binding per gameplay scene lifetime and route that scene's
pause/input/visibility policy through the controller. This is a single-writer
contract, not automatic arbitration of unrelated direct scene writes.

The binding records only changes it starts. A previously paused scene is never
resumed by block release or disposal. Sleeping/stopped scenes are not resumed;
an external wake reapplies remaining blocks. External sleep revokes the binding's
pause/visibility ownership. Observable external pause/resume events update ownership;
a resume while blocked is reconciled immediately. Restoration resumes last so
resume callbacks can restart a scene without old cleanup overwriting its new binding.
It does not claim to detect an external pause that
overlaps an already-owned pause without an observable state transition.

`shutdown` and `destroy` remove binding listeners and dispose the supplied view
scope. Ordinary scene shutdown restores owned input/audio without resuming or
showing the stopped scene. It does not destroy the shared application runtime.
A restarted scene must create a fresh binding and scope. A CREATE listener
handles installation inside `scene.create()` before the first gameplay update.

Explicit `dispose()` restores owned state where the scene is still eligible,
then detaches. Runtime destruction detaches and disposes the scope while keeping
current engine controls intact: it must not generate a resume or unmute request.
Late releases and repeated cleanup cannot control a new scene lifetime. Resume
is driven by controller notifications; no paused-scene update polling is needed.

## Validation and distribution

The headless fake tests exercise ownership, input flags/reset, channel mapping,
CREATE handling, shutdown/restart, external sleep/wake, and terminal cleanup.
`examples/runtime-controls` separately runs real Phaser 4.2.0 in Chromium and
asserts actual update/render counters and input behavior. Its initial inactive
scenario verifies the first update is blocked. The audio fixture is a fake sink,
not a physical-device audio test. Native targets and every Phaser version are
not covered by that browser result.

The implementation was checked against the installed Phaser 4.2.0 source and
the official [Systems API](https://docs.phaser.io/api-documentation/4.0.0/class/scenes-systems).
The separate package keeps Phaser outside headless runtime imports; its peer
range starts at the tested 4.2.0 version.

This package remains private pending initial npm registration and Trusted
Publishing/OIDC setup. It is not a generated-game dependency and does not modify
`phaser-minigame-runtime`'s native compatibility layer. No changeset is required
for these private-only contracts.

If the injected audio sink throws while unmuting during disposal/shutdown, scene
listeners still detach. The handle retains only its failed audio cleanup and a
subsequent explicit `dispose()` retries it while the runtime is active. Successful
cleanup stays idempotent; terminal runtime destruction never retries an unmute.
Complete this explicit cleanup before reusing the same sink for another binding,
as required by the single-writer ownership contract. No retry timer is installed.
