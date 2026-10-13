import { createFrameLoop, type FrameLoop, type FrameScheduler } from './loop';
import type { LiteRenderer, StageSize } from './renderer';
import { defaultTapThreshold, TapRecognizer, type TapThreshold } from './tap';

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
  readonly onTap?: (tap: LiteTap) => void;
  readonly onResize?: (size: StageSize) => void;
  readonly tapThreshold?: TapThreshold;
  readonly scheduler?: FrameScheduler;
}

export interface LiteShell<Surface> {
  readonly renderer: LiteRenderer<Surface>;
  readonly size: StageSize;
  /** Request frames; call after state changes. */
  invalidate(): void;
  readonly loop: FrameLoop;
  dispose(): void;
}

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

  let size: StageSize = { width: 0, height: 0, dpr: 1 };
  const loop = createFrameLoop({
    tick: (delta, time) => options.frame(renderer.surface, delta, time),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });

  const measure = (): void => {
    const rect = mount.getBoundingClientRect();
    size = { width: rect.width, height: rect.height, dpr: globalThis.devicePixelRatio || 1 };
    renderer.resize(size);
    options.onResize?.(size);
    loop.wake();
  };

  const recognizer = new TapRecognizer(options.tapThreshold ?? defaultTapThreshold);
  const point = (event: PointerEvent) => ({
    x: event.clientX,
    y: event.clientY,
    time: event.timeStamp,
  });
  const onDown = (event: PointerEvent) => recognizer.down(event.pointerId, point(event));
  const onMove = (event: PointerEvent) => recognizer.move(event.pointerId, point(event));
  const onCancel = (event: PointerEvent) => recognizer.cancel(event.pointerId);
  const onUp = (event: PointerEvent) => {
    if (recognizer.up(event.pointerId, point(event))) {
      const rect = element.getBoundingClientRect();
      options.onTap?.({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      loop.wake();
    }
  };
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onCancel);

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
  observer?.observe(mount);
  measure();

  return {
    renderer,
    get size() {
      return size;
    },
    invalidate: () => loop.wake(),
    loop,
    dispose() {
      observer?.disconnect();
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
      loop.dispose();
      renderer.dispose();
    },
  };
}
