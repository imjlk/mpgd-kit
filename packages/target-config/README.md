# Target configuration

Target-specific feature availability, effective configuration and viewport helpers.

## Responsive game shell

`@mpgd/target-config/adaptive-shell` is an opt-in DOM entrypoint over the existing
viewport composition APIs. Import `@mpgd/target-config/adaptive-shell/base.css`
before application paint styles; every selector has zero specificity.

```ts
import { mountAdaptiveGameShell, waitForAdaptiveShellViewport } from '@mpgd/target-config/adaptive-shell';
const initialMeasurement = await waitForAdaptiveShellViewport(gameRoot);
const shell = mountAdaptiveGameShell({ gameRoot, runtime,
  initialMeasurement, policy: { gameAspectRatio: 3 / 4, minRailWidth: 160 } });
const stop = shell.subscribe(({ composition }) => resizeGame(composition.gameBounds));
// Teardown: stop(); shell.destroy();
```

The shell applies safe bounds to the stage and optional left/right rails. Aspect
ratio, rail threshold, panel slots (at most 64), element IDs/classes and all visual
content remain consumer-owned. Authored slots define a readiness data attribute,
a CSS variable prefix, min/max width, gutter and minimum rail height; their
left/top/width variables are written on the owning document root. Inputs are
snapshotted before observation starts and invalid policy/slot/measurement inputs
fail before DOM restructuring.
Each live controller reserves its slot variable prefixes in the owning document.
Another stage using one of those prefixes fails before either stage is changed;
destroy releases them, and replacing the same stage transfers ownership. Separate
documents may reuse the same prefixes.

ResizeObserver, window and visual-viewport events coalesce through one animation
frame. A new controller for the same stage disposes its previous owner. Destroy
is idempotent, detaches observers/listeners, ignores late callbacks and clears
slot variables. It leaves the shell/stage/rails and their bounds in the DOM;
remove those elements separately if the page outlives the game. Embedded stages
use their own document/window. Subscriber errors do not skip other listeners and
are rethrown in a microtask for the host's error reporting. Importing the module
creates no observers, elements or listeners and does not load a platform SDK.

Startup waits accept `{ signal }` so teardown can cancel a still-unmeasurable
surface and detach observation. Fixed shells prefer visual-viewport dimensions
and follow its resize/scroll offsets; document-root panel variables include those
offsets. This covers keyboard/zoom changes that leave layout-viewport dimensions
unchanged ([VisualViewport reference](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)).
