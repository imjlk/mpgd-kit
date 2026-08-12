# Tutorial Engine

`@mpgd/tutorial` separates game-owned onboarding content from reusable tutorial
progression and presentation. Version `0.1.0` is registered publicly on npm.
Future package releases use Sampo changesets through the OIDC-enabled
`.github/workflows/release.yml` workflow and its configured npm Trusted Publisher.

The package does not decide what a game teaches, how a Phaser simulation is
paused, or whether a help button exists. A game owns those policies.

## Package boundaries

| Import | Responsibility |
| --- | --- |
| `@mpgd/tutorial` | DOM-free definitions, progress parsing, and the tutorial director |
| `@mpgd/tutorial/platform-storage` | Queued persistence through a `PlatformGateway.storage`-compatible adapter |
| `@mpgd/tutorial/driver` | Optional Driver.js DOM presentation and replay-trigger binding |
| `@mpgd/tutorial/testing` | Memory storage, DEV URL policy, and an opt-in browser debug bridge |

The root import is safe in Node and does not load Driver.js. Import
`@mpgd/tutorial/driver.css` explicitly when the Driver presenter is used. Games
can override its neutral CSS variables without moving their visual theme into
the kit.

## Define and run a tutorial

```ts
import {
  createTutorialDirector,
  defineTutorial,
  type TutorialStepOf,
} from '@mpgd/tutorial';
import { createPlatformTutorialProgressStore } from '@mpgd/tutorial/platform-storage';

const tutorial = defineTutorial({
  id: 'my-game.prologue',
  initialScene: 'lobby',
  revision: 1,
  steps: [
    {
      id: 'welcome',
      scene: 'lobby',
      target: 'lobby-welcome',
      interaction: 'blocked',
      advance: { kind: 'acknowledge' },
      content: {
        titleKey: 'tutorialWelcomeTitle',
        descriptionKey: 'tutorialWelcomeDescription',
      },
    },
    {
      id: 'start',
      scene: 'lobby',
      target: 'start-stage',
      interaction: 'target',
      advance: { kind: 'action', action: 'stage.start' },
    },
    {
      id: 'move',
      scene: 'play',
      target: 'play-field',
      interaction: 'gameplay',
      advance: { kind: 'signal', signal: 'worker.moved' },
    },
  ],
} as const);

const progressStore = await createPlatformTutorialProgressStore({
  definition: tutorial,
  key: 'my-game.tutorial-progress.v1',
  storage: platform.storage,
});
const director = createTutorialDirector({
  autoStart: isNewPlayer,
  definition: tutorial,
  initialScene: 'lobby',
  progressStore,
});

director.observeAction('stage.start');
director.observeScene('play');
director.observeSignal('worker.moved');
await director.flush();
director.destroy();
```

Action and signal steps advance only while their required scene is active.
Hidden steps wait for a real game signal without opening a popover. Progress
records require the exact completed-step prefix and definition revision; invalid
records fail closed by default.

Initialization reads use a bounded `loadTimeoutMs` (10 seconds by default).
Writes stay serialized and `flush()` waits for their actual adapter result;
`StorageAdapter.save()` has no cancellation contract, so the tutorial store
never reports an uncancellable write as failed while it may still commit.

Changing the meaning or order of persisted steps requires a new `revision` and
an explicit migration, or a new tutorial ID/storage key.

## Optional Driver.js presentation

```ts
import '@mpgd/tutorial/driver.css';

import { createDriverTutorialPresenter } from '@mpgd/tutorial/driver';

const presenter = createDriverTutorialPresenter<TutorialStepOf<typeof tutorial>>({
  onAcknowledge: (stepId) => director.acknowledge(stepId),
  onSkip: () => director.skip(),
});

const unsubscribe = director.subscribe((snapshot) => {
  const step = snapshot.presentedStep;
  presenter.present(step === null ? null : {
    copy: {
      title: t(step.content.titleKey),
      description: t(step.content.descriptionKey),
      next: t('next'),
      done: t('done'),
      skip: t('skip'),
    },
    finalStep: step.id === tutorial.steps.at(-1)?.id,
    step,
  });
});
```

Targets use stable game-owned IDs:

```html
<button data-mpgd-tutorial-target="start-stage">Start</button>
```

When responsive layouts render the same target more than once, the presenter
selects the visible in-viewport element and rebinds on DOM or viewport changes.
Open shadow roots present at mount or added through DOM mutations are observed
automatically. If an already-connected host calls `attachShadow()` later, CSS
changes through a CSSOM API such as `insertRule()`, or an external stylesheet
finishes loading, call `presenter.refresh()` afterward because those changes do
not reliably emit an observed DOM mutation.
Driver keyboard navigation is disabled so gameplay arrow keys remain available.
Blocked guidance becomes the active modal; interactive guidance inside an
existing game modal is exposed as a region owned by that modal. Original ARIA
attributes are restored when presentation ends.

Driver.js renders through the current page's global document. The presenter can
scope target lookup to an element in that document, but intentionally rejects
an iframe or secondary `Document` root. Mount a presenter inside that realm
instead when a target wrapper uses an iframe.

## The help button is host-owned

The package never creates a production help button. A game can provide a header
`?`, a Settings action, or no replay entry point at all:

```ts
import { bindTutorialReplayTrigger } from '@mpgd/tutorial/driver';

const helpButton = document.querySelector<HTMLElement>('[data-action="tutorial-replay"]');
const unbind = helpButton === null
  ? () => undefined
  : bindTutorialReplayTrigger({
      beforeReplay: () => navigateToTutorialStart(),
      director,
      element: helpButton,
      presenter,
    });
```

`beforeReplay` is important when the trigger can appear outside the tutorial's
initial scene. `presenter` lets the binding clear a successful same-step skip
dismissal only after `replay()` succeeds; ordinary `null` to same-step host
rerenders remain suppressed. A host that invokes `director.replay()` directly
should await `presenter.waitForPendingSkip()` immediately before replay, then call
`presenter.resetForReplay()` after the replay promise resolves. Use the same
ordering in `beforeReplay` and `afterReplay` when installing a debug bridge, so
its console and optional floating replay triggers follow the same lifecycle.
`replay()` itself remains navigation-agnostic. Completing or skipping
an in-session replay restores the prior durable progress exactly, whether it was
active, completed, skipped, or `null` when no prior progress existed.

## Local reproduction

Run the private browser harness:

```sh
pnpm dev:tutorial
```

Useful URLs:

```text
http://localhost:5198/
http://localhost:5198/?host-trigger=0
http://localhost:5198/?trigger=1&host-trigger=0
http://localhost:5198/?mpgd-tutorial=off
http://localhost:5198/?mpgd-tutorial=replay&mpgd-tutorial-step=modal-choice
```

- `host-trigger=0` proves the host can omit its replay UI.
- `trigger=1` explicitly adds a debug-only floating `?`; it is never enabled by
  the package on its own.
- `mpgd-tutorial=off` suspends presentation even when progress is active.
- `mpgd-tutorial=replay` starts an in-session replay without erasing durable
  progress. `mpgd-tutorial-step` opens a known specific step; an unknown ID
  falls back to a full replay.

URL policy is applied only when the caller passes `enabled: true`, normally from
`import.meta.env.DEV`. The debug bridge is also opt-in:

```ts
const debug = installTutorialDebugBridge({
  afterReplay: () => presenter.resetForReplay(),
  director,
  beforeReplay: async (options) => {
    await presenter.waitForPendingSkip();
    await prepareHostFor(options.fromStepId);
    await presenter.waitForPendingSkip();
  },
  floatingReplayTrigger: false,
});

window.__MPGD_TUTORIAL__.getSnapshot();
window.__MPGD_TUTORIAL__.goToStep('move');
window.__MPGD_TUTORIAL__.signal('worker.moved');
```

Destroy the bridge, presenter, subscriptions, and director during host teardown,
and call `director.flush()` before teardown when queued persistence must finish.

## Game-owned responsibilities

Keep these outside the kit:

- tutorial steps, localized copy, and analytics IDs;
- Phaser/world event interpretation such as movement distance, collisions,
  category matches, pickups, and upgrades;
- simulation blocking and resume policy;
- scene navigation before replay;
- visual theme and placement of any production help entry point.

This keeps the package reusable without making Driver.js, a specific scene
graph, or one game's terminology part of the platform contract.
