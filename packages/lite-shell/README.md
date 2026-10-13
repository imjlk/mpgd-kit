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
  frame: ({ context, size }) => { context.clearRect(0, 0, size.width, size.height); return false; },
  onTap: (tap, event) => { /* event is the original PointerEvent */ },
  onFirstFrame: () => performance.mark('first-frame'),
});
```

See `docs/LITE_TEMPLATE.md` in the mpgd-kit repo for details.
