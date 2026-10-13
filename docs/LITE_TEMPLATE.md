# Lite template (Phaser-free)

The lite template is a first-class alternative to the Phaser starter for games
that do not need a scene graph: daily puzzles, word and letter games, tap
games, and Devvit inline posts that must load in about a second.

The kit's value is distribution, not rendering. A lite game keeps every
platform gateway, target wrapper (Devvit, Apps in Toss, Capacitor, web portals),
release manifest, icon pipeline, and smoke check of the Phaser template. Only
the renderer changes.

## Create a lite game

```sh
mpgd game create my-game --template lite              # --renderer canvas is the default
mpgd game create my-game --template lite --renderer canvas
```

`--renderer` names a `LiteRenderer` implementation. `canvas` (Canvas2D) ships
today; `dom` and `svg` are reserved extension points (see below). Passing
`--renderer` without `--template lite` is an error.

Compared with the Phaser template the generator:

- removes `src/scenes/*`, `src/assets/manifest.ts`, and `src/assets/marker.svg`;
- replaces `src/runtime/createGame.ts` with a lite-shell mount and adds
  `src/lite/tapGame.ts` (the starter gameplay, state still in `src/game/state.ts`);
- replaces `src/platform/devvitEntrypoint.ts` so the Devvit inline surface is
  playable (tap only) instead of a static poster, while `main.ts` stays a
  dynamic import used only by the expanded surface;
- removes `phaser` and `@mpgd/phaser-assets` and adds `@mpgd/lite-shell`;
- sets `agent/game-manifest.json` `game.engine` to `lite-canvas`.

The reference project is [`examples/lite-starter`](https://github.com/imjlk/mpgd-kit/tree/main/examples/lite-starter),
generated with `--template lite --workspace` and extended with an optional
`matter-js` collapse loaded by `import()` on the fifth hit.

## `@mpgd/lite-shell`

| Export | Purpose |
| --- | --- |
| `createLiteShell({ mount, renderer, frame, onTap })` | Mounts a renderer surface, resizes it with `ResizeObserver` and the device pixel ratio, routes taps, and drives a frame loop. |
| `createCanvasRenderer({ maxDpr })` | Canvas2D renderer. Draw in CSS pixels; the backing store is scaled by DPR (capped at 3). |
| `createFrameLoop({ tick })` | `requestAnimationFrame` loop that sleeps when `tick` returns false. Call `shell.invalidate()` after state changes. An idle inline post uses no CPU. |
| `TapRecognizer`, `defaultTapThreshold` | A press is a tap only if it moves at most 10 CSS px and lasts at most 600 ms, so feed scrolls and long presses never become game input. |
| `loadFontSubset`, `collectGlyphs` | Load a bundled woff2 subset with a timeout before first paint (so text measurement matches rendering) and list the glyphs to subset. |

The stage element uses `touch-action: manipulation`: the browser keeps
vertical panning (the host feed scrolls) and only taps reach the game.

### Adding a renderer

A renderer implements `LiteRenderer<Surface>`:

```ts
interface LiteRenderer<Surface> {
  readonly kind: 'canvas' | 'dom' | 'svg';
  readonly element: HTMLElement | SVGElement; // mounted by the shell
  readonly surface: Surface;                  // passed to frame()
  resize(size: { width: number; height: number; dpr: number }): void;
  dispose(): void;
}
```

The shell owns layout, input, and the loop, so a DOM or SVG renderer only has
to own its element. To ship one, add it to `@mpgd/lite-shell`, add the id to
`supportedLiteRenderers` in `packages/cli/src/index.ts`, and add a renderer
overlay for the template's `src/lite/` files.

## Devvit inline acceptance

Reddit's inline (feed) view has stricter rules than expanded mode. Reddit's
[view modes documentation](https://developers.reddit.com/docs/capabilities/server/launch_screen_and_entry_points/view_modes_entry_points)
asks inline experiences to:

1. render a first meaningful frame within about 1 second;
2. score above 80 on mobile Lighthouse performance;
3. use taps only: no drag, swipe, long-press, or device-motion input;
4. never block feed scrolling (no `preventDefault` on touch moves,
   no `touch-action: none` on the inline surface);
5. move heavier play (editors, physics-heavy stages, drag input) to expanded
   mode with `requestExpandedMode`.

The kit enforces the parts that can be checked from build output. Opt in on
the Devvit target:

```json
"reddit": {
  "kind": "devvit-web",
  "inlineEntry": "index.html",
  "inlineBudget": {
    "maxGzipKb": 40,
    "forbidModules": ["phaser", "matter-js"],
    "deferredChunks": ["main.js", "matter.js"]
  }
}
```

`mpgd target smoke reddit` then walks the inline entry's load graph (HTML
scripts, modulepreloads, stylesheets, static imports, and dynamic `import()`
edges) and fails when:

- a `forbidModules` entry is reachable, matched by chunk name or a content
  signature (`phaser`, `matter-js`, `pixi`, `three`);
- the gzip total exceeds `maxGzipKb`.

`deferredChunks` (paths relative to the Devvit client output, `*` wildcards)
mark chunks that only the expanded surface or a user interaction fetches; they
and anything reachable only through them are excluded. Without `inlineEntry`
nothing new is checked, so existing Phaser games such as ttokdoku are
unaffected. A Phaser game can still use `inlineEntry` to prove its inline
poster does not pull Phaser.

Load time, Lighthouse, and scroll behavior still need a device or Devvit
playtest; the smoke check only guards bundle composition and size.

`examples/lite-starter` measures 11.2 KiB gzip for the inline first load
(the Devvit adapter, the text-selection policy, and the lite shell), with
Phaser absent from every chunk and `matter-js` loaded on demand.

## Publishing status

`@mpgd/lite-shell` is `private` until its first npm publish (see
`AGENTS.md`). Until then, lite games outside a kit checkout must be generated
with `--workspace --kit-path <mpgd-kit>` (or use a `link:` dependency); a
non-workspace `mpgd game create --template lite` writes `^0.1.0`, which cannot
be installed yet.
