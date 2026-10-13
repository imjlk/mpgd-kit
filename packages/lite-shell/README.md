# @mpgd/lite-shell

Renderer-agnostic lightweight game shell (no Phaser): DPR-aware stage, scroll-safe
tap input, idle-sleeping frame loop, font subset loading, and a Canvas2D renderer.
Built for inline surfaces such as Reddit Devvit posts.

```ts
import { createCanvasRenderer, createLiteShell } from '@mpgd/lite-shell';

const shell = createLiteShell({
  mount: document.getElementById('app')!,
  renderer: createCanvasRenderer(),
  contentHeight: (width) => width * 0.75, // optional: height follows content
  initialHeight: 240, // optional: reserve the expected height to avoid a layout shift
  frame: ({ context, size }) => { context.clearRect(0, 0, size.width, size.height); return false; },
  onTap: (tap, event) => { /* event is the original PointerEvent */ },
  onFirstFrame: (time, size) => performance.mark('first-frame'), // fires once width > 0
});
```

DPR changes are picked up from both a `matchMedia` resolution listener and the
window `resize` event (unchanged sizes are skipped).

```ts
await loadFontSubset(
  { family: 'Game', url: fontUrl, weight: '700' },
  { timeoutMs: 1500, display: 'block', onLateLoad: () => shell.refit() },
);
```

A font that arrives after the timeout is still added to `document.fonts`, and
`onLateLoad` lets you re-measure and redraw.

## Building

Requires Node >= 20 to consume. Inside the kit, `pnpm build` uses the workspace
build tooling (the kit itself needs Node 24 and pnpm 11 via corepack). Outside a
full workspace install, `pnpm build:standalone` (`tsc -p tsconfig.build.json`)
emits the same `dist/`.

See `docs/LITE_TEMPLATE.md` in the mpgd-kit repo for details.
