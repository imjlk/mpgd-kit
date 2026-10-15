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
mpgd game create my-game --template lite --workspace --kit-path <mpgd-kit>
mpgd game create my-game --template lite --renderer canvas --workspace --kit-path <mpgd-kit>
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

The reference project is `examples/lite-starter`,
generated with `--template lite --workspace` and extended with an optional
`matter-js` collapse loaded by `import()` on the fifth hit.

## `@mpgd/lite-shell`

| Export | Purpose |
| --- | --- |
| `createLiteShell({ mount, renderer, frame, onTap, onFirstFrame, contentHeight, initialHeight })` | Mounts a renderer surface, resizes it with `ResizeObserver` and the device pixel ratio (a `matchMedia` resolution listener plus the window `resize` event re-scale on zoom or monitor changes; engines that only fire `resize` are covered), routes taps, and drives a frame loop. `onTap(tap, event)` receives the original `PointerEvent`, so `requestExpandedMode(event, ...)` keeps its user activation. `onFirstFrame(time, size)` fires once after the first draw on a stage with width > 0 (use it for first-paint marks or to hide a placeholder). `contentHeight(width)` makes the height follow content: the mount height is set to the returned CSS px; call `shell.refit()` when content changes. Pass `initialHeight` (or set the same CSS height on the mount) to reserve the expected height so the host page does not shift when the real height is applied. Unchanged sizes never re-resize the backing store. |
| `createCanvasRenderer({ maxDpr })` | Canvas2D renderer. Draw in CSS pixels; the backing store is scaled by DPR (capped at 3). |
| `createFrameLoop({ tick })` | `requestAnimationFrame` loop that sleeps when `tick` returns false. Call `shell.invalidate()` after state changes. An idle inline post uses no CPU. |
| `TapRecognizer`, `defaultTapThreshold` | A press is a tap only if it moves at most 10 CSS px and lasts at most 600 ms, so feed scrolls and long presses never become game input. |
| `loadFontSubset`, `collectGlyphs` | Load a bundled woff2 subset with a timeout before first paint (so text measurement matches rendering). `display` sets the FontFace descriptor (default `block`); a font that loads after the timeout is still added and reported through `onLateLoad` and list the glyphs to subset. |

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
scripts, preloads, stylesheets, local media, static imports, and dynamic
`import()` edges) and fails when:

- a `forbidModules` entry is reachable, matched by chunk name or a content
  signature (`phaser`, `matter-js`, `pixi`, `three`);
- the gzip total exceeds `maxGzipKb`;
- an inline budget is configured and a first-load resource uses an external URL
  whose bytes cannot be verified from the artifact. Bundle those resources locally.

HTML bytes, CSS-referenced fonts and images, and every local `srcset` or
`imagesrcset` candidate count toward the total. Responsive candidates are
counted conservatively because the build has no fixed viewport or DPR.
HTML attributes may be quoted or unquoted; inline `style` URLs also count.
Eager iframe documents (including `srcdoc`) and CSS `image-set` candidates count.
Executable and stylesheet data URLs have their dependencies inspected; their payload
bytes are already included in the containing resource. Relative dependencies inside
data URLs are unsupported; emit artifact files for those dependencies.
JavaScript imports and CSS values are parsed as syntax, so imports or URLs shown
in strings or comments do not add dependencies. Distinct query URLs are charged separately, even when
they use the same local file. A `base href` is unsupported; emit artifact-relative
URLs instead. Inspection without a budget reports external references.

`deferredChunks` (paths relative to the Devvit client output, `*` wildcards)
mark chunks that only the expanded surface or a user interaction fetches; they
and anything reachable only through them are excluded. Without `inlineEntry`
nothing new is checked, so existing Phaser games such as ttokdoku are
unaffected. A Phaser game can still use `inlineEntry` to prove its inline
poster does not pull Phaser.

Load time, Lighthouse, and scroll behavior still need a device or Devvit
playtest; the smoke check only guards bundle composition and size.

`examples/lite-starter` measures about 12 KiB gzip for the HTML-inclusive inline first load
(the Devvit adapter, the text-selection policy, and the lite shell), with
Phaser absent from every chunk and `matter-js` loaded on demand.

## Windows consumer verification

The Windows CI matrix generates both the Phaser packed consumer and the lite
workspace consumer with `--microsoft-store`. Each goes through dependency install,
frozen install, type checking, web/PWA build, and native WinUI packaging. Separate
x64 and ARM64 runners install and activate each generated MSIX, checking its game
bundle hash, non-empty canvas, boot errors, and native bridge contracts. Native
artifacts and receipts include the template name so results cannot be mixed.

The lite lane uses `--template lite --workspace --kit-path ...` while
`@mpgd/lite-shell` remains private. Run the generation/build portion locally with
`MPGD_WINDOWS_SMOKE_TEMPLATE=lite pnpm smoke:windows-starter` in a disposable
checkout after building KIT packages. The generated workspace install rewrites
dependency links in that checkout's workspace packages. The smoke command checks
and compiles KIT tools before installation, then reuses that checked emit for
nested target commands. Native package
installation runs on isolated CI machines.

## Publishing status

`@mpgd/lite-shell` 0.1.0 builds ESM JavaScript and
`.d.ts` files to `dist/` (`pnpm --filter @mpgd/lite-shell build`, or
`pnpm build:standalone` without a full workspace install; consumers need
Node >= 20), uses
explicit `.js` relative imports so plain Node ESM can load it, and its test
script imports the built output as a consumer would. Per `AGENTS.md`, the
maintainer registers it with one local initial publish of `0.1.0` and then adds
its Sampo release-group entry and npm Trusted Publishing before automated
releases. The package stays private until that registration is complete.
Until then, generate lite games with `--workspace --kit-path <mpgd-kit>`.
The CLI rejects non-workspace lite generation before writing a project.
See [Game Project Models](./GAME_PROJECT_MODELS.md#workspace-games-and-kit-dependency-links)
for how a workspace game's install re-links kit packages and how to restore them.
