import { createFrameLoop, type FrameLoop, type FrameScheduler } from './loop.js';
import type { LiteRenderer, StageSize } from './renderer.js';
import { defaultTapThreshold, TapRecognizer, type TapThreshold } from './tap.js';

export interface LiteTap {
  /** Stage-local CSS pixel coordinates. */
  readonly x: number;
  readonly y: number;
}

export interface LiteShellOptions<Surface> {
  readonly mount: HTMLElement;
  readonly renderer: LiteRenderer<Surface>;
  /** Draw one frame. Return true while more frames are needed. */
  readonly frame: (surface: Surface, deltaMs: number, time: number) => boolean;
  /**
   * Called for each recognized tap. `event` is the original `pointerup`, so
   * user-activation APIs such as Devvit `requestExpandedMode(event, ...)` work.
   */
  readonly onTap?: (tap: LiteTap, event: PointerEvent) => void;
  readonly onResize?: (size: StageSize) => void;
  /**
   * Called once, right after the first frame drawn on a non-empty stage
   * (width > 0), with that stage size. Frames drawn while the mount is still
   * zero-width (hidden, not yet laid out) do not count.
   */
  readonly onFirstFrame?: (time: number, size: StageSize) => void;
  /**
   * CSS height (px) applied to the mount before the first measure when
   * `contentHeight` is used. Set it to your expected content height so the
   * host page does not shift when the real height is applied.
   */
  readonly initialHeight?: number;
  /**
   * Content-driven height. When set, the stage width follows the mount and the
   * height is `contentHeight(width)` CSS px (the mount's height is set to it).
   * Call `shell.refit()` after content changes. Default: fill the mount.
   */
  readonly contentHeight?: (width: number) => number;
  readonly tapThreshold?: TapThreshold;
  readonly scheduler?: FrameScheduler;
}

export interface LiteShell<Surface> {
  readonly renderer: LiteRenderer<Surface>;
  readonly size: StageSize;
  /** Request frames; call after state changes. */
  invalidate(): void;
  /** Re-measure (and re-run `contentHeight`), resizing only if something changed. */
  refit(): void;
  readonly loop: FrameLoop;
  dispose(): void;
}

const currentDpr = (): number => globalThis.devicePixelRatio || 1;

/**
 * Mount a lightweight stage. Touch uses `touch-action: manipulation` so the
 * host page (for example a Reddit feed) keeps vertical scrolling; only short,
 * still presses are delivered as taps.
 */
export function createLiteShell<Surface>(options: LiteShellOptions<Surface>): LiteShell<Surface> {
  const { mount, renderer } = options;
  const element = renderer.element as HTMLElement;
  element.style.touchAction = 'manipulation';
  element.style.userSelect = 'none';
  mount.append(element);

  if (options.contentHeight !== undefined && options.initialHeight !== undefined && !mount.style.height) {
    mount.style.height = `${Math.max(0, Math.ceil(options.initialHeight))}px`;
  }

  let size: StageSize = { width: 0, height: 0, dpr: 1 };
  let measuredSize: StageSize | undefined;
  let firstFrameDone = options.onFirstFrame === undefined;
  let disposed = false;
  const loop = createFrameLoop({
    tick: (delta, time) => {
      const more = options.frame(renderer.surface, delta, time);
      if (!firstFrameDone && size.width > 0) {
        firstFrameDone = true;
        options.onFirstFrame?.(time, size);
      }
      return more;
    },
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });

  const measure = (): void => {
    if (disposed) {
      return;
    }
    const rect = mount.getBoundingClientRect();
    const width = rect.width;
    let height = rect.height;
    if (options.contentHeight !== undefined) {
      height = Math.max(0, Math.ceil(options.contentHeight(width)));
      const css = `${height}px`;
      // Setting the same value does not trigger another observer callback.
      if (mount.style.height !== css) {
        mount.style.height = css;
      }
    }
    const dpr = currentDpr();
    if (measuredSize !== undefined && width === measuredSize.width && height === measuredSize.height && dpr === measuredSize.dpr) {
      return; // no change: avoid clearing the backing store twice
    }
    measuredSize = { width, height, dpr };
    renderer.resize(measuredSize);
    size = renderer.size ?? measuredSize;
    options.onResize?.(size);
    loop.wake();
  };

  const recognizer = new TapRecognizer(options.tapThreshold ?? defaultTapThreshold);
  const point = (event: PointerEvent) => ({
    x: event.clientX,
    y: event.clientY,
    time: event.timeStamp,
  });
  const onDown = (event: PointerEvent) => {
    if (event.isPrimary && event.button === 0) {
      recognizer.down(event.pointerId, point(event));
    }
  };
  const onMove = (event: PointerEvent) => recognizer.move(event.pointerId, point(event));
  const onCancel = (event: PointerEvent) => recognizer.cancel(event.pointerId);
  const onUp = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0) {
      recognizer.cancel(event.pointerId);
      return;
    }
    if (recognizer.up(event.pointerId, point(event))) {
      const rect = element.getBoundingClientRect();
      options.onTap?.({ x: event.clientX - rect.left, y: event.clientY - rect.top }, event);
      loop.wake();
    }
  };
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onCancel);

  // DPR changes (browser zoom, moving between monitors) don't resize the mount,
  // so watch the current resolution and re-arm after each change.
  let dprQuery: MediaQueryList | undefined;
  const onDprChange = (): void => {
    watchDpr();
    measure();
  };
  const watchDpr = (): void => {
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery = typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia(`(resolution: ${currentDpr()}dppx)`)
      : undefined;
    dprQuery?.addEventListener('change', onDprChange);
  };
  watchDpr();
  // Some engines (and headless browsers) only report a DPR change through a
  // window resize; `measure` is a no-op when nothing changed.
  const onWindowResize = (): void => {
    if (dprQuery !== undefined && !dprQuery.media.includes(`${currentDpr()}dppx`)) {
      watchDpr();
    }
    measure();
  };
  globalThis.addEventListener?.('resize', onWindowResize);

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
  observer?.observe(mount);
  measure();

  return {
    renderer,
    get size() {
      return size;
    },
    invalidate: () => loop.wake(),
    refit: measure,
    loop,
    dispose() {
      disposed = true;
      observer?.disconnect();
      dprQuery?.removeEventListener('change', onDprChange);
      globalThis.removeEventListener?.('resize', onWindowResize);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
      loop.dispose();
      renderer.dispose();
    },
  };
}
