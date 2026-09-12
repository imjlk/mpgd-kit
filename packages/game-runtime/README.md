# Game runtime (private preview)

`@mpgd/game-runtime` coordinates gameplay execution with owned block tokens.
It has no Phaser, DOM, network, platform SDK, timer, or polling dependency.
It does not change engine state, replace score-oriented `GameSession`, or alter
`PlatformGateway`. Engine and UI consumers apply the requested state separately.

```ts
import { createGameExecutionController } from '@mpgd/game-runtime';

const runtime = createGameExecutionController({ onListenerError: reportError });
const settings = runtime.acquireBlock({
  reason: 'settings', channels: ['simulation', 'gameplay-input'],
});
const background = runtime.acquireBlock({
  reason: 'background', channels: ['simulation', 'gameplay-input', 'audio'],
});
background.release(); // Settings still blocks simulation and gameplay input.
settings.release();   // Those channels may now resume.
runtime.destroy();    // Terminal; this never requests gameplay resume.
```

| Channel | Request |
| --- | --- |
| `simulation` | Stop gameplay simulation updates |
| `gameplay-input` | Block gameplay input, leaving pause/resume UI usable |
| `rendering` | Suppress gameplay rendering according to the engine binding policy |
| `audio` | Mute gameplay audio through an explicit audio sink |

Each channel is blocked while any token includes it. Equal reasons create
independent tokens. Only the returned token can release its block; diagnostic
IDs are local to a controller and cannot be used to release anything. Release
and unsubscribe are idempotent. Keep an additional token for user-confirmed
resume; the core supplies no countdown or automatic resume policy.

`getSnapshot()` returns the same reference until a successful acquisition,
first release, or first destruction. Each increments `version` once, including
changes to token diagnostics that leave the effective channel flags unchanged.
Snapshots, channel flags, token lists, token information, and channel arrays
are frozen. Caller arrays are copied; no consumer object is frozen.

`subscribe` does not emit initially: subscribe, then read `getSnapshot()`.
Listeners run in registration order. Each notification round captures its
snapshot and recipient list. Reentrant state changes are immediate but their
notifications queue behind the current round. Newly registered listeners only
receive future rounds; unsubscribed listeners are skipped even in a captured
round. Read the callback argument for that round's state, since `getSnapshot()`
may already reflect a reentrant change. Duplicate registrations are independent.

Synchronous exceptions and rejected listener promises go to optional
`onListenerError`. Promises are observed without awaiting them. Errors from
that hook are consumed; no global logging or transport is installed. Listeners
must not produce an unbounded cycle of state changes.

`destroy` is terminal and idempotent. It clears owned blocks, emits a terminal
snapshot with every channel blocked, and removes listeners. Destruction also
supersedes outstanding active notification rounds, preventing a stale resume
notification after shutdown. Late token releases are no-ops; new acquisitions
and subscriptions throw. Destroying this coordination object does not terminate
the game process. Consumers must check `status` before applying engine controls.

This package remains `private: true` until an initial local npm publish and
Trusted Publishing/OIDC setup are explicitly completed. It is not a generated
game dependency. These private-only changes require no Sampo changeset.

Contributor validation: `pnpm --dir packages/game-runtime test`,
`node tools/run-ttsx.mjs tools/package/build-packages.ts @mpgd/game-runtime`,
and `node packages/game-runtime/test/dist-import.mjs`.
