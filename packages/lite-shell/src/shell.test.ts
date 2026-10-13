import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LiteRenderer, StageSize } from './renderer.js';
import { createLiteShell } from './shell.js';
import { loadFontSubset } from './font.js';

type Listener = (event: never) => void;

function fakeElement(rect = { left: 0, top: 0, width: 300, height: 200 }) {
  const listeners = new Map<string, Listener>();
  return {
    rect,
    style: {} as Record<string, string>,
    listeners,
    append: () => undefined,
    remove: () => undefined,
    getBoundingClientRect: () => rect,
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
}

function setup(extra: Record<string, unknown> = {}) {
  const mount = fakeElement();
  const element = fakeElement({ left: 10, top: 20, width: 300, height: 200 });
  const resizes: StageSize[] = [];
  const renderer: LiteRenderer<null> = {
    kind: 'canvas',
    element: element as unknown as HTMLElement,
    surface: null,
    resize: (size) => resizes.push(size),
    dispose: () => undefined,
  };
  const frames: ((time: number) => void)[] = [];
  const shell = createLiteShell({
    mount: mount as unknown as HTMLElement,
    renderer,
    frame: () => false,
    scheduler: { request: (cb) => frames.push(cb), cancel: () => undefined },
    ...extra,
  });
  return { shell, mount, element, resizes, frames };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLiteShell', () => {
  it('passes the original PointerEvent to onTap', () => {
    const onTap = vi.fn();
    const { element } = setup({ onTap });
    const event = { pointerId: 1, clientX: 30, clientY: 40, timeStamp: 0 };
    (element.listeners.get('pointerdown') as (e: unknown) => void)(event);
    const up = { ...event, timeStamp: 50 };
    (element.listeners.get('pointerup') as (e: unknown) => void)(up);
    expect(onTap).toHaveBeenCalledWith({ x: 20, y: 20 }, up);
  });

  it('calls onFirstFrame exactly once', () => {
    const onFirstFrame = vi.fn();
    const { shell, frames } = setup({ onFirstFrame });
    frames.shift()?.(16);
    shell.invalidate();
    frames.shift()?.(32);
    expect(onFirstFrame).toHaveBeenCalledTimes(1);
    expect(onFirstFrame).toHaveBeenCalledWith(16, { width: 300, height: 200, dpr: 1 });
  });

  it('waits for a non-zero stage width before onFirstFrame', () => {
    const onFirstFrame = vi.fn();
    const { shell, frames, mount } = setup({ onFirstFrame, contentHeight: () => 100 });
    mount.rect.width = 0;
    shell.refit();
    frames.shift()?.(16);
    expect(onFirstFrame).not.toHaveBeenCalled();
    mount.rect.width = 320;
    shell.refit();
    frames.shift()?.(32);
    expect(onFirstFrame).toHaveBeenCalledWith(32, { width: 320, height: 100, dpr: 1 });
  });

  it('applies initialHeight before measuring content', () => {
    const heights: string[] = [];
    const mount = fakeElement();
    const style = new Proxy({} as Record<string, string>, {
      set: (t, k: string, v: string) => {
        if (k === 'height') {
          heights.push(v);
        }
        t[k] = v;
        return true;
      },
    });
    (mount as { style: Record<string, string> }).style = style;
    const element = fakeElement();
    createLiteShell({
      mount: mount as unknown as HTMLElement,
      renderer: { kind: 'canvas', element: element as unknown as HTMLElement, surface: null, resize: () => undefined, dispose: () => undefined },
      frame: () => false,
      scheduler: { request: () => 0, cancel: () => undefined },
      contentHeight: () => 206,
      initialHeight: 206,
    });
    expect(heights).toEqual(['206px']);
  });

  it('re-scales on a window resize that only changes DPR', () => {
    const win = new Map<string, () => void>();
    vi.stubGlobal('devicePixelRatio', 1);
    vi.stubGlobal('addEventListener', (t: string, fn: () => void) => win.set(t, fn));
    vi.stubGlobal('removeEventListener', (t: string) => win.delete(t));
    const { resizes, shell } = setup();
    expect(resizes).toHaveLength(1);
    win.get('resize')?.();
    expect(resizes).toHaveLength(1); // unchanged: skipped
    vi.stubGlobal('devicePixelRatio', 2);
    win.get('resize')?.();
    expect(resizes.at(-1)).toEqual({ width: 300, height: 200, dpr: 2 });
    shell.dispose();
    expect(win.has('resize')).toBe(false);
  });

  it('sizes height from content and skips redundant resizes', () => {
    const { shell, mount, resizes } = setup({ contentHeight: (w: number) => w / 2 });
    expect(mount.style.height).toBe('150px');
    expect(resizes).toEqual([{ width: 300, height: 150, dpr: 1 }]);
    shell.refit();
    expect(resizes).toHaveLength(1);
    mount.rect.width = 400;
    shell.refit();
    expect(resizes.at(-1)).toEqual({ width: 400, height: 200, dpr: 1 });
  });

  it('re-scales when the device pixel ratio changes', () => {
    const queries: { media: string; fire?: () => void; removed: boolean }[] = [];
    vi.stubGlobal('devicePixelRatio', 1);
    vi.stubGlobal('matchMedia', (media: string) => {
      const q = { media, removed: false } as (typeof queries)[number];
      queries.push(q);
      return {
        addEventListener: (_: string, fn: () => void) => {
          q.fire = fn;
        },
        removeEventListener: () => {
          q.removed = true;
        },
      };
    });
    const { resizes, shell } = setup();
    expect(queries[0]?.media).toBe('(resolution: 1dppx)');
    vi.stubGlobal('devicePixelRatio', 2);
    queries[0]?.fire?.();
    expect(resizes.at(-1)?.dpr).toBe(2);
    expect(queries[0]?.removed).toBe(true);
    expect(queries[1]?.media).toBe('(resolution: 2dppx)');
    shell.dispose();
    expect(queries[1]?.removed).toBe(true);
  });
});

describe('loadFontSubset', () => {
  it('clears the timeout timer once the font settles', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const added: unknown[] = [];
    vi.stubGlobal('document', { fonts: { add: (f: unknown) => added.push(f) } });
    vi.stubGlobal('FontFace', class {
      load() {
        return Promise.resolve(this);
      }
    });
    const loaded = loadFontSubset({ family: 'X', url: 'x.woff2' }, { timeoutMs: 60_000 });
    await expect(loaded).resolves.toBe(true);
    expect(added).toHaveLength(1);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('uses the display option and keeps a font that loads after the timeout', async () => {
    vi.useFakeTimers();
    const added: unknown[] = [];
    let release: (v: unknown) => void = () => undefined;
    let descriptors: Record<string, string> = {};
    vi.stubGlobal('document', { fonts: { add: (f: unknown) => added.push(f) } });
    vi.stubGlobal('FontFace', class {
      constructor(_f: string, _s: string, d: Record<string, string>) { descriptors = d; }
      load() { return new Promise((r) => { release = () => r(this); }); }
    });
    const onLateLoad = vi.fn();
    const result = loadFontSubset({ family: 'X', url: 'x.woff2' }, { timeoutMs: 100, display: 'swap', onLateLoad });
    expect(descriptors.display).toBe('swap');
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(false);
    expect(added).toHaveLength(0);
    release(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(added).toHaveLength(1);
    expect(onLateLoad).toHaveBeenCalledWith(added[0]);
    vi.useRealTimers();
  });
});
