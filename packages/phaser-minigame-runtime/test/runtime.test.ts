import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyMiniGameRequestUrl,
  createMiniGamePhaserConfig,
  getInstalledMiniGameGlobals,
  getMiniGameCanvasBounds,
  installMiniGameGlobals,
  installMiniGameTouchInput,
  installPhaserMiniGameRuntime,
  mapMiniGameTouchToDesign,
  MiniGameAnimationFrameScheduler,
  MiniGameCanvasElement,
  MiniGameEvent,
  MiniGameEventTarget,
  MiniGameImageElement,
  miniGamePhaserCanvasRenderer,
  MiniGameTouchEvent,
  MiniGameXMLHttpRequest,
  type MiniGamePhaserGame,
} from '../src/index.js';
import { encodeText, FakeMiniGameHost } from './fake-host.js';

afterEach(() => {
  getInstalledMiniGameGlobals()?.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mini-game globals and Canvas compatibility', () => {
  it('installs globals once and separates the primary and offscreen canvases', () => {
    const host = new FakeMiniGameHost();
    const installation = installMiniGameGlobals(host);
    const duplicate = installMiniGameGlobals(host);

    expect(duplicate).toBe(installation);
    expect(globalThis.window).toBe(globalThis);
    expect(globalThis.document).toBe(installation.document);
    expect(globalThis.document.getElementById('game')).toBe(installation.document.body);
    expect(globalThis.document.getElementById('mpgd-game-canvas')).toBe(installation.canvas);
    expect(installation.document.body.dataset.mpgdPreserveBrowserTouchGestures).toBeUndefined();
    installation.document.body.dataset.mpgdPreserveBrowserTouchGestures = 'true';
    expect(installation.document.body.getAttribute(
      'data-mpgd-preserve-browser-touch-gestures',
    )).toBe('true');
    installation.document.body.setAttribute('data-render-mode', 'canvas');
    expect(installation.document.body.dataset.renderMode).toBe('canvas');
    expect(Object.keys(installation.document.body.dataset)).toEqual([
      'mpgdPreserveBrowserTouchGestures',
      'renderMode',
    ]);
    delete installation.document.body.dataset.renderMode;
    expect(installation.document.body.hasAttribute('data-render-mode')).toBe(false);
    expect(installation.canvas).toBeInstanceOf(MiniGameCanvasElement);
    expect(host.createdCanvasTypes).toEqual(['primary']);
    let windowListenerThis: unknown;
    let windowEvent: MiniGameEvent | undefined;
    const windowListener = function listener(this: unknown, event: MiniGameEvent): void {
      windowListenerThis = this;
      windowEvent = event;
    };
    const addWindowListener = Reflect.get(globalThis, 'addEventListener');
    const focusWindow = Reflect.get(globalThis, 'focus');

    expect(typeof addWindowListener).toBe('function');
    expect(typeof focusWindow).toBe('function');

    if (typeof addWindowListener !== 'function' || typeof focusWindow !== 'function') {
      throw new Error('Mini-game window event globals were not installed.');
    }

    Reflect.apply(addWindowListener, globalThis, ['focus', windowListener]);
    Reflect.apply(focusWindow, globalThis, []);
    expect(windowListenerThis).toBe(globalThis);
    expect(windowEvent?.target).toBe(globalThis);
    expect(windowEvent?.currentTarget).toBe(globalThis);

    const offscreen = globalThis.document.createElement('canvas');

    expect(offscreen).toBeInstanceOf(MiniGameCanvasElement);
    expect(offscreen).not.toBe(installation.canvas);
    expect(host.createdCanvasTypes).toEqual(['primary', 'offscreen']);
    offscreen.setAttribute('width', '320');
    offscreen.setAttribute('height', '180');
    expect(offscreen.width).toBe(320);
    expect(offscreen.height).toBe(180);
    expect(() => offscreen.setAttribute('width', '-1')).toThrow(
      'canvas width must be a non-negative finite number',
    );
    const firstMount = globalThis.document.createElement('div');
    const secondMount = globalThis.document.createElement('div');
    installation.document.body.appendChild(firstMount);
    installation.document.body.appendChild(secondMount);
    firstMount.appendChild(offscreen);
    secondMount.appendChild(offscreen);
    expect(firstMount.contains(offscreen)).toBe(false);
    expect(secondMount.contains(offscreen)).toBe(true);
    expect(offscreen.contains(offscreen)).toBe(true);
    firstMount.insertBefore(offscreen, null);
    expect(firstMount.contains(offscreen)).toBe(true);
    expect(secondMount.contains(offscreen)).toBe(false);
    expect(() => offscreen.appendChild(firstMount)).toThrow(
      'cannot be appended to themselves or their descendants',
    );

    installation.canvas.style.width = '600px';
    installation.canvas.style.height = '300px';
    installation.canvas.style.setProperty('margin-left', '100px');
    installation.canvas.style.marginTop = '75px';
    expect(installation.canvas.getBoundingClientRect()).toMatchObject({
      x: 100,
      y: 75,
      left: 100,
      top: 75,
      right: 700,
      bottom: 375,
      width: 600,
      height: 300,
    });
    expect(installation.canvas.clientWidth).toBe(600);
    expect(installation.canvas.clientHeight).toBe(300);
    expect(mapMiniGameTouchToDesign(
      { identifier: 1, clientX: 400, clientY: 225 },
      host.getWindowInfo(),
      { width: 1200, height: 600 },
      installation.canvas.getBoundingClientRect(),
    )).toEqual({ x: 600, y: 300 });
    installation.canvas.style.marginLeft = 'auto';
    installation.canvas.style.marginTop = 'auto';
    expect(installation.canvas.getBoundingClientRect()).toMatchObject({
      left: 100,
      top: 75,
      width: 600,
      height: 300,
    });
    expect(() => globalThis.document.createElement('section')).toThrow(
      "does not implement document.createElement('section')",
    );
    expect(() => globalThis.document.createElement('script')).toThrow(
      'does not permit <script>',
    );
  });

  it('accepts only duplicate global installs with equivalent runtime options', () => {
    const host = new FakeMiniGameHost();
    const onAnimationFrameError = () => undefined;
    const imageOrigins = ['https://images.example.com', 'https://shared.example.com'];
    const transportOrigins = ['https://api.example.com'];
    const installation = installMiniGameGlobals(host, {
      image: {
        pollIntervalMs: 8,
        loadTimeoutMs: 2_000,
        allowedRemoteOrigins: imageOrigins,
      },
      transport: {
        requestTimeoutMs: 1_000,
        allowedRemoteOrigins: transportOrigins,
      },
      onAnimationFrameError,
    });
    imageOrigins.push('https://mutated.example.com');
    transportOrigins.push('https://mutated.example.com');

    const equivalent = installMiniGameGlobals(host, {
      image: {
        pollIntervalMs: 8,
        loadTimeoutMs: 2_000,
        allowedRemoteOrigins: ['https://shared.example.com', 'https://images.example.com'],
      },
      transport: {
        requestTimeoutMs: 1_000,
        allowedRemoteOrigins: ['https://api.example.com'],
      },
      onAnimationFrameError,
    });

    expect(equivalent).toBe(installation);
    expect(() => installMiniGameGlobals(host, {
      image: { pollIntervalMs: 16 },
    })).toThrow('already installed with different runtime options');
    expect(() => installMiniGameGlobals(host, {
      transport: { allowedRemoteOrigins: ['https://other.example.com'] },
    })).toThrow('already installed with different runtime options');
    expect(() => installMiniGameGlobals(host, {
      onAnimationFrameError: () => undefined,
    })).toThrow('already installed with different runtime options');
  });

  it('reserves global installation across synchronous host reentry', () => {
    class ReentrantGlobalsHost extends FakeMiniGameHost {
      attemptedReentry = false;
      reentryError: unknown;

      override getWindowInfo(): ReturnType<FakeMiniGameHost['getWindowInfo']> {
        if (!this.attemptedReentry) {
          this.attemptedReentry = true;

          try {
            installMiniGameGlobals(this);
          } catch (error) {
            this.reentryError = error;
          }
        }

        return super.getWindowInfo();
      }
    }

    const host = new ReentrantGlobalsHost();
    const installation = installMiniGameGlobals(host);

    expect(host.reentryError).toMatchObject({
      code: 'MINIGAME_GLOBALS_INSTALL_REENTRANT',
    });
    expect(getInstalledMiniGameGlobals()).toBe(installation);
    expect(host.createdCanvasTypes).toEqual(['primary']);
    expect(host.touchListenerCount).toBe(4);
  });

  it('releases the global installation reservation after constructor failure', () => {
    class FailingReentrantGlobalsHost extends FakeMiniGameHost {
      attemptedReentry = false;
      reentryError: unknown;

      override getWindowInfo(): ReturnType<FakeMiniGameHost['getWindowInfo']> {
        if (!this.attemptedReentry) {
          this.attemptedReentry = true;

          try {
            installMiniGameGlobals(this);
          } catch (error) {
            this.reentryError = error;
          }

          throw new Error('outer installation failed');
        }

        return super.getWindowInfo();
      }
    }

    const failedHost = new FailingReentrantGlobalsHost();
    expect(() => installMiniGameGlobals(failedHost)).toThrow('outer installation failed');
    expect(failedHost.reentryError).toMatchObject({
      code: 'MINIGAME_GLOBALS_INSTALL_REENTRANT',
    });
    expect(getInstalledMiniGameGlobals()).toBeUndefined();

    const recoveredInstallation = installMiniGameGlobals(new FakeMiniGameHost());
    expect(getInstalledMiniGameGlobals()).toBe(recoveredInstallation);
  });

  it('unwraps mini-game image wrappers passed to drawImage', async () => {
    const host = new FakeMiniGameHost();
    const installation = installMiniGameGlobals(host);
    const image = new globalThis.Image();
    const loaded = new Promise<void>((resolve) => {
      image.onload = (event) => {
        expect(event.target).toBe(image);
        resolve();
      };
    });
    image.src = 'assets/marker.png';
    await loaded;

    const context = installation.canvas.getContext('2d') as {
      readonly canvas: unknown;
      drawImage(source: unknown, x: number, y: number): void;
      measureText(text: string): unknown;
      readonly __state: Readonly<{ readonly drawImageSources: readonly unknown[] }>;
    };
    expect(context.canvas).toBe(installation.canvas);
    expect(context.drawImage).toBe(context.drawImage);
    expect(context.measureText).toBe(context.measureText);
    context.drawImage(image, 0, 0);

    expect(image).toBeInstanceOf(MiniGameImageElement);
    expect(context.__state.drawImageSources).toHaveLength(1);
    expect(context.__state.drawImageSources[0]).not.toBe(image);

    const reloaded = new Promise<void>((resolve) => {
      image.onload = () => resolve();
    });
    image.src = 'assets/marker-2.png';
    context.drawImage(image, 0, 0);
    const reloadingNativeImage = context.__state.drawImageSources[1];

    expect(Reflect.get(reloadingNativeImage as object, 'src')).toBe('assets/marker-2.png');
    expect(Reflect.get(reloadingNativeImage as object, 'complete')).toBe(false);
    await reloaded;

    image.src = '';
    context.drawImage(image, 0, 0);
    const clearedNativeImage = context.__state.drawImageSources[2];

    expect(image.src).toBe('');
    expect(Reflect.get(clearedNativeImage as object, 'src')).toBe('');
    expect(Reflect.get(clearedNativeImage as object, 'width')).toBe(0);
    expect(image.complete).toBe(true);

    const originalDrawImage = context.drawImage;
    Reflect.set(context, 'drawImage', () => undefined);
    expect(context.drawImage).not.toBe(originalDrawImage);
    expect(context.drawImage).toBe(context.drawImage);
  });

  it('isolates native image callbacks across source generations', () => {
    class ControlledImageHost extends FakeMiniGameHost {
      readonly completeImageLoads: Array<() => void> = [];

      override createImage(): object {
        const image: Record<string, unknown> = {
          width: 0,
          height: 0,
          complete: false,
          onload: null,
          onerror: null,
        };

        Object.defineProperty(image, 'src', {
          configurable: true,
          get: () => image.__src ?? '',
          set: (value: string) => {
            image.__src = value;

            if (value.length === 0) {
              image.width = 0;
              image.height = 0;
              image.complete = false;
              return;
            }

            const dimension = value.includes('second') ? 2 : 1;
            this.completeImageLoads.push(() => {
              image.width = dimension;
              image.height = dimension;
              image.complete = true;
              const onload = image.onload;

              if (typeof onload === 'function') {
                Reflect.apply(onload, image, []);
              }
            });
          },
        });

        return image;
      }
    }

    const host = new ControlledImageHost();
    installMiniGameGlobals(host, {
      image: { pollIntervalMs: 100, loadTimeoutMs: 1_000 },
    });
    const image = new globalThis.Image();
    let loadEvents = 0;
    image.onload = () => {
      loadEvents += 1;
    };

    image.src = 'assets/first.png';
    image.src = 'assets/second.png';

    expect(host.completeImageLoads).toHaveLength(2);
    host.completeImageLoads[0]?.();
    expect(loadEvents).toBe(0);
    expect(image.complete).toBe(false);
    expect(image.width).toBe(0);

    host.completeImageLoads[1]?.();
    expect(loadEvents).toBe(1);
    expect(image.complete).toBe(true);
    expect(image.width).toBe(2);

    image.src = 'assets/cancelled.png';
    expect(host.completeImageLoads).toHaveLength(3);
    image.removeAttribute('SRC');
    expect(image.src).toBe('');
    expect(image.complete).toBe(true);
    expect(image.width).toBe(0);
    host.completeImageLoads[2]?.();
    expect(loadEvents).toBe(1);
    expect(image.src).toBe('');
    expect(image.width).toBe(0);
  });

  it('resolves percentage vertical margins against the containing width', () => {
    const windowInfo = { width: 360, height: 640, pixelRatio: 2 } as const;
    const bounds = getMiniGameCanvasBounds(windowInfo, {
      width: '100%',
      height: '50%',
      marginTop: '10%',
    });

    expect(bounds).toMatchObject({
      left: 0,
      top: 36,
      width: 360,
      height: 320,
      bottom: 356,
    });
    expect(mapMiniGameTouchToDesign(
      { identifier: 1, clientX: 180, clientY: 196 },
      windowInfo,
      { width: 720, height: 640 },
      bounds,
    )).toEqual({ x: 360, y: 320 });
  });

  it('prevents recursive global disposal and permits retry after a guard rejects', () => {
    const globals = installMiniGameGlobals(new FakeMiniGameHost());
    let rejectDisposal = true;
    let recursiveCalls = 0;
    globals.registerDisposalGuard(() => {
      recursiveCalls += 1;
      globals.dispose();
    });
    globals.registerDisposalGuard(() => {
      if (rejectDisposal) {
        throw new Error('not ready');
      }
    });

    expect(() => globals.dispose()).toThrow('not ready');
    expect(globals.disposed).toBe(false);
    expect(recursiveCalls).toBe(1);

    rejectDisposal = false;
    globals.dispose();
    expect(globals.disposed).toBe(true);
    expect(recursiveCalls).toBe(2);
  });

  it('uses bounded image polling when native callbacks are absent', async () => {
    const host = new FakeMiniGameHost();
    host.imageBehavior = 'poll-load';
    installMiniGameGlobals(host, {
      image: { pollIntervalMs: 1, loadTimeoutMs: 50 },
    });
    const image = new globalThis.Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unexpected image error'));
    });
    image.src = 'assets/polled.png';

    await loaded;
    expect(image.complete).toBe(true);
    expect(image.width).toBe(2);
  });

  it('treats an explicit incomplete image signal as authoritative during polling', async () => {
    class ExplicitlyIncompleteImageHost extends FakeMiniGameHost {
      override createImage(): object {
        const image: Record<string, unknown> = {
          width: 0,
          height: 0,
          complete: false,
          onload: null,
          onerror: null,
        };

        Object.defineProperty(image, 'src', {
          configurable: true,
          get: () => image.__src ?? '',
          set: (value: string) => {
            image.__src = value;

            if (value.length === 0) {
              image.width = 0;
              image.height = 0;
              return;
            }

            queueMicrotask(() => {
              image.width = 2;
              image.height = 2;
            });
          },
        });

        return image;
      }
    }

    installMiniGameGlobals(new ExplicitlyIncompleteImageHost(), {
      image: { pollIntervalMs: 1, loadTimeoutMs: 5 },
    });
    const image = new globalThis.Image();
    let loadEvents = 0;
    image.onload = () => {
      loadEvents += 1;
    };
    const timeoutError = new Promise<unknown>((resolve) => {
      image.onerror = (event) => resolve(event);
    });
    image.src = 'assets/incomplete.png';

    await expect(timeoutError).resolves.toMatchObject({
      type: 'error',
      error: { code: 'MINIGAME_IMAGE_LOAD_TIMEOUT' },
    });
    expect(loadEvents).toBe(0);
  });

  it('uses a dimension transition only when the native completion signal is absent', async () => {
    class DimensionOnlyImageHost extends FakeMiniGameHost {
      override createImage(): object {
        const image: Record<string, unknown> = {
          width: 0,
          height: 0,
          onload: null,
          onerror: null,
        };

        Object.defineProperty(image, 'src', {
          configurable: true,
          get: () => image.__src ?? '',
          set: (value: string) => {
            image.__src = value;

            if (value.length === 0) {
              image.width = 0;
              image.height = 0;
              return;
            }

            queueMicrotask(() => {
              image.width = 2;
              image.height = 2;
            });
          },
        });

        return image;
      }
    }

    installMiniGameGlobals(new DimensionOnlyImageHost(), {
      image: { pollIntervalMs: 1, loadTimeoutMs: 50 },
    });
    const image = new globalThis.Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Unexpected image error'));
    });
    image.src = 'assets/dimension-only.png';

    await loaded;
    expect(image.complete).toBe(true);
    expect(image.width).toBe(2);
    expect(image.height).toBe(2);
  });

  it('reports native image errors and bounded polling timeouts', async () => {
    const failedHost = new FakeMiniGameHost();
    failedHost.imageBehavior = 'error';
    const failedInstallation = installMiniGameGlobals(failedHost);
    const failedImage = new globalThis.Image();
    const nativeError = new Promise<void>((resolve) => {
      failedImage.onerror = () => resolve();
    });
    failedImage.src = 'assets/missing.png';
    await nativeError;
    expect(failedImage.complete).toBe(true);
    failedInstallation.dispose();

    const pendingHost = new FakeMiniGameHost();
    pendingHost.imageBehavior = 'pending';
    installMiniGameGlobals(pendingHost, {
      image: { pollIntervalMs: 1, loadTimeoutMs: 5 },
    });
    const pendingImage = new globalThis.Image();
    const timeoutError = new Promise<unknown>((resolve) => {
      pendingImage.onerror = (event) => resolve(event);
    });
    pendingImage.src = 'assets/never.png';

    await expect(timeoutError).resolves.toMatchObject({ type: 'error' });
  });

  it('rejects invalid image timing and reports unsafe image sources asynchronously', async () => {
    const host = new FakeMiniGameHost();
    installMiniGameGlobals(host, {
      image: { pollIntervalMs: 0 },
    });

    expect(() => new globalThis.Image()).toThrow('pollIntervalMs must be a positive');
    getInstalledMiniGameGlobals()?.dispose();
    installMiniGameGlobals(host);

    for (const [source, code] of [
      ['blob:minigame-image', 'MINIGAME_IMAGE_PROTOCOL_BLOCKED'],
      ['//untrusted.example/image.png', 'MINIGAME_IMAGE_PROTOCOL_BLOCKED'],
      [String.raw`\\untrusted.example\image.png`, 'MINIGAME_IMAGE_PROTOCOL_BLOCKED'],
      ['../secret.png', 'MINIGAME_IMAGE_LOCAL_PATH_INVALID'],
    ] as const) {
      const image = new globalThis.Image();
      let assignmentReturned = false;
      const blockedSourceError = new Promise<unknown>((resolve) => {
        image.onerror = (event) => {
          expect(assignmentReturned).toBe(true);
          resolve(event);
        };
      });

      image.src = source;
      assignmentReturned = true;

      await expect(blockedSourceError).resolves.toMatchObject({
        type: 'error',
        error: { code },
      });
    }
  });

  it('keeps same-target listeners after stopPropagation and honors stopImmediatePropagation', () => {
    const eventTarget = new MiniGameCanvasElement(
      new FakeMiniGameHost().createCanvas({ type: 'primary' }),
      () => ({ width: 100, height: 100, pixelRatio: 1 }),
    );
    const calls: string[] = [];
    eventTarget.addEventListener('normal', (event) => {
      calls.push('normal-first');
      event.stopPropagation();
    });
    eventTarget.addEventListener('normal', () => calls.push('normal-second'));
    eventTarget.addEventListener('immediate', (event) => {
      calls.push('immediate-first');
      event.stopImmediatePropagation();
    });
    eventTarget.addEventListener('immediate', () => calls.push('immediate-second'));
    eventTarget.addEventListener('pre-stopped', () => calls.push('pre-stopped'));

    eventTarget.dispatchEvent(new MiniGameEvent('normal'));
    eventTarget.dispatchEvent(new MiniGameEvent('immediate'));
    const preStopped = new MiniGameEvent('pre-stopped');
    preStopped.stopImmediatePropagation();
    eventTarget.dispatchEvent(preStopped);

    expect(calls).toEqual(['normal-first', 'normal-second', 'immediate-first']);
  });

  it('continues event dispatch after reporting a listener exception', () => {
    const listenerError = new Error('listener failed');
    const reported: Array<Readonly<{ readonly error: unknown; readonly type: string }>> = [];
    const eventTarget = new MiniGameEventTarget((error, event) => {
      reported.push({ error, type: event.type });
    });
    const calls: string[] = [];
    eventTarget.addEventListener('load', () => {
      calls.push('failing');
      throw listenerError;
    });
    eventTarget.addEventListener('load', () => calls.push('remaining'));

    expect(() => eventTarget.dispatchEvent(new MiniGameEvent('load'))).not.toThrow();
    expect(calls).toEqual(['failing', 'remaining']);
    expect(reported).toEqual([{ error: listenerError, type: 'load' }]);
  });

  it('skips a listener removed before its turn in the current dispatch', () => {
    const eventTarget = new MiniGameEventTarget();
    const calls: string[] = [];
    const removedListener = (): void => {
      calls.push('removed');
    };
    eventTarget.addEventListener('touchstart', () => {
      calls.push('remover');
      eventTarget.removeEventListener('touchstart', removedListener);
    });
    eventTarget.addEventListener('touchstart', removedListener);

    eventTarget.dispatchEvent(new MiniGameEvent('touchstart'));

    expect(calls).toEqual(['remover']);
  });

  it('forwards touch start, move, end, and cancel and removes listeners on dispose', () => {
    const host = new FakeMiniGameHost();
    const installation = installMiniGameGlobals(host);
    const eventTypes: string[] = [];
    const changedCoordinates: Array<readonly [number, number]> = [];

    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const) {
      installation.canvas.addEventListener(type, (event) => {
        const touchEvent = event as MiniGameTouchEvent;
        eventTypes.push(touchEvent.type);
        const changed = touchEvent.changedTouches[0];

        if (changed !== undefined) {
          changedCoordinates.push([changed.clientX, changed.clientY]);
        }
      });
    }

    const touch = [{ identifier: 7, clientX: 400, clientY: 225 }] as const;
    host.emitTouch('start', touch);
    host.emitTouch('move', touch);
    host.emitTouch('end', touch);
    host.emitTouch('start', touch);
    host.emitTouch('cancel', touch);

    expect(eventTypes).toEqual([
      'touchstart',
      'touchmove',
      'touchend',
      'touchstart',
      'touchcancel',
    ]);
    expect(changedCoordinates[0]).toEqual([400, 225]);
    expect(mapMiniGameTouchToDesign(touch[0], host.getWindowInfo(), {
      width: 1600,
      height: 900,
    })).toEqual({ x: 800, y: 450 });
    expect(() => mapMiniGameTouchToDesign(touch[0], host.getWindowInfo(), {
      width: 0,
      height: 900,
    })).toThrow('design width and height must be positive');
    expect(host.touchListenerCount).toBe(4);

    installation.dispose();
    expect(host.touchListenerCount).toBe(0);
    host.emitTouch('start', touch);
    expect(eventTypes).toHaveLength(5);
  });

  it('rolls back touch subscriptions and deactivates an invalid leaked callback', () => {
    class InvalidTouchHost extends FakeMiniGameHost {
      override onTouchMove(
        callback: Parameters<FakeMiniGameHost['onTouchMove']>[0],
      ): () => void {
        super.onTouchMove(callback);
        return undefined as never;
      }
    }

    const host = new InvalidTouchHost();
    const canvas = new MiniGameCanvasElement(
      host.createCanvas({ type: 'primary' }),
      () => host.getWindowInfo(),
    );
    let moves = 0;
    canvas.addEventListener('touchmove', () => {
      moves += 1;
    });

    expect(() => installMiniGameTouchInput(host, canvas)).toThrow(
      'onTouchMove must return an unsubscribe function',
    );
    expect(host.touchListenerCount).toBe(1);
    host.emitTouch('move', [{ identifier: 1, clientX: 10, clientY: 10 }]);
    expect(moves).toBe(0);
  });
});

describe('mini-game requestAnimationFrame and transport', () => {
  it('keeps recursively scheduled frames alive after a callback exception', () => {
    const host = new FakeMiniGameHost();
    const errors: unknown[] = [];
    const scheduler = new MiniGameAnimationFrameScheduler(host, (error) => errors.push(error));
    let frames = 0;
    const step = (): void => {
      frames += 1;
      scheduler.request(step);

      if (frames === 1) {
        throw new Error('frame failed');
      }
    };

    scheduler.request(step);
    host.flushFrame(16);
    host.flushFrame(32);
    host.flushFrame(48);

    expect(frames).toBe(3);
    expect(errors).toHaveLength(1);
    scheduler.dispose();
    expect(host.pendingFrameCount).toBe(0);
  });

  it('continues global cleanup when host frame cancellation throws', () => {
    class ThrowingCancelHost extends FakeMiniGameHost {
      override cancelAnimationFrame(_id: number): void {
        throw new Error('cancel failed');
      }
    }

    const host = new ThrowingCancelHost();
    const errors: unknown[] = [];
    const globals = installMiniGameGlobals(host, {
      onAnimationFrameError: (error) => errors.push(error),
    });
    let frames = 0;
    globalThis.requestAnimationFrame(() => {
      frames += 1;
    });
    globalThis.requestAnimationFrame(() => {
      frames += 1;
    });
    expect(host.pendingFrameCount).toBe(2);

    expect(() => globals.dispose()).not.toThrow();
    expect(globals.disposed).toBe(true);
    expect(getInstalledMiniGameGlobals()).toBeUndefined();
    expect(errors).toHaveLength(2);

    host.flushFrame(16);
    expect(frames).toBe(0);
  });

  it('loads local JSON and binary responses with the Phaser XHR surface', async () => {
    const host = new FakeMiniGameHost();
    host.localFiles.set('assets/config.json', encodeText('{"level":3}'));
    host.localFiles.set('assets/data.bin', new Uint8Array([1, 2, 3]).buffer);

    const jsonRequest = new MiniGameXMLHttpRequest(host);
    jsonRequest.open('GET', './assets/config.json');
    jsonRequest.responseType = 'json';
    await sendRequest(jsonRequest);
    expect(jsonRequest.status).toBe(200);
    expect(jsonRequest.readyState).toBe(jsonRequest.DONE);
    expect(jsonRequest.response).toEqual({ level: 3 });

    const binaryRequest = new MiniGameXMLHttpRequest(host);
    binaryRequest.open('GET', '/assets/data.bin');
    binaryRequest.responseType = 'arraybuffer';
    await sendRequest(binaryRequest);
    expect([...new Uint8Array(binaryRequest.response as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it('decodes Unicode local files without browser TextEncoder or TextDecoder globals', async () => {
    const host = new FakeMiniGameHost();
    const value = '{"label":"한글 😀"}';
    host.localFiles.set('assets/unicode.json', encodeText(value));
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    const request = new MiniGameXMLHttpRequest(host);
    request.open('GET', 'assets/unicode.json');
    request.responseType = 'json';

    await sendRequest(request);
    expect(request.response).toEqual({ label: '한글 😀' });
  });

  it.each([
    { name: 'empty', body: '' },
    { name: 'malformed', body: '{"broken"' },
  ])('completes $name JSON responses with a null parsed value', async ({ body }) => {
    const host = new FakeMiniGameHost();
    host.localFiles.set('assets/invalid.json', encodeText(body));
    const request = new MiniGameXMLHttpRequest(host);
    let errors = 0;
    request.addEventListener('error', () => {
      errors += 1;
    });
    request.open('GET', 'assets/invalid.json');
    request.responseType = 'json';

    await sendRequest(request);
    expect(request.status).toBe(200);
    expect(request.readyState).toBe(request.DONE);
    expect(request.responseText).toBe(body);
    expect(request.response).toBeNull();
    expect(errors).toBe(0);
  });

  it('rejects duplicate sends, credential forwarding, and unsupported response types', async () => {
    const host = new FakeMiniGameHost();
    host.localFiles.set('assets/value.json', encodeText('{}'));
    const request = new MiniGameXMLHttpRequest(host);
    request.open('GET', 'assets/value.json');
    const loaded = sendRequest(request);
    expect(() => {
      request.responseType = 'arraybuffer';
    }).toThrow('responseType cannot change after send() starts');
    expect(() => request.setRequestHeader('x-late', 'ignored')).toThrow(
      'headers cannot change after send() starts',
    );
    expect(() => request.send()).toThrow('only be called once per open');
    await loaded;

    const credentialed = new MiniGameXMLHttpRequest(host);
    credentialed.open('GET', 'assets/value.json');
    credentialed.withCredentials = true;
    expect(() => credentialed.send()).toThrow('does not support withCredentials');

    const unsupported = new MiniGameXMLHttpRequest(host);
    unsupported.open('GET', 'assets/value.json');
    Reflect.set(unsupported, 'responseType', 'blob');
    expect(() => unsupported.send()).toThrow('does not support responseType blob');
  });

  it('honors aborts raised by XHR lifecycle callbacks without starting transport', async () => {
    const host = new FakeMiniGameHost();
    const stagedRequest = new MiniGameXMLHttpRequest(host);
    let stagedAborts = 0;
    let stagedLoadEnds = 0;
    stagedRequest.onabort = () => {
      stagedAborts += 1;
    };
    stagedRequest.onloadend = () => {
      stagedLoadEnds += 1;
    };
    stagedRequest.open('GET', 'assets/staged.json');
    stagedRequest.abort();
    expect(stagedRequest.readyState).toBe(stagedRequest.OPENED);
    expect(stagedAborts).toBe(0);
    expect(stagedLoadEnds).toBe(0);

    const readLocalFile = vi.spyOn(host, 'readLocalFile');
    const request = new MiniGameXMLHttpRequest(host);
    let abortEventReadyState: number | undefined;
    request.open('GET', 'assets/aborted.json');
    const aborted = new Promise<void>((resolve) => {
      request.onabort = () => {
        abortEventReadyState = request.readyState;
        resolve();
      };
    });
    request.onloadstart = () => request.abort();
    request.send();

    await aborted;
    expect(abortEventReadyState).toBe(request.DONE);
    expect(request.readyState).toBe(request.UNSENT);
    expect(readLocalFile).not.toHaveBeenCalled();

    host.localFiles.set('assets/completed.json', encodeText('{"ok":true}'));
    const completedRequest = new MiniGameXMLHttpRequest(host);
    completedRequest.open('GET', 'assets/completed.json');
    completedRequest.responseType = 'json';
    await sendRequest(completedRequest);
    expect(completedRequest.readyState).toBe(completedRequest.DONE);
    completedRequest.abort();
    expect(completedRequest.readyState).toBe(completedRequest.UNSENT);
    expect(completedRequest.status).toBe(0);
    expect(completedRequest.response).toBeNull();
  });

  it('clears response metadata when aborting after response headers arrive', async () => {
    const host = new FakeMiniGameHost();
    host.remoteResponse = {
      status: 200,
      data: 'partial response',
      headers: { 'content-type': 'text/plain', 'x-request-id': 'request-1' },
    };
    const request = new MiniGameXMLHttpRequest(host, {
      allowedRemoteOrigins: ['https://cdn.example.com'],
    });
    let sawHeaders = false;
    request.onreadystatechange = () => {
      if (request.readyState === request.HEADERS_RECEIVED) {
        sawHeaders = request.getResponseHeader('x-request-id') === 'request-1';
        request.abort();
      }
    };
    const aborted = new Promise<void>((resolve) => {
      request.onabort = () => resolve();
    });
    request.open('GET', 'https://cdn.example.com/partial.txt');
    request.send();

    await aborted;
    expect(sawHeaders).toBe(true);
    expect(request.status).toBe(0);
    expect(request.statusText).toBe('');
    expect(request.responseURL).toBe('');
    expect(request.response).toBeNull();
    expect(request.responseText).toBe('');
    expect(request.getResponseHeader('x-request-id')).toBeNull();
    expect(request.getAllResponseHeaders()).toBe('');
  });

  it('does not carry a MIME override across open calls', async () => {
    const host = new FakeMiniGameHost();
    host.localFiles.set('assets/first.txt', encodeText('first'));
    host.localFiles.set('assets/second.txt', encodeText('second'));
    const request = new MiniGameXMLHttpRequest(host);
    request.open('GET', 'assets/first.txt');
    request.overrideMimeType('text/custom');
    request.responseType = 'text';
    await sendRequest(request);
    expect(request.getResponseHeader('content-type')).toBe('text/custom');

    request.open('GET', 'assets/second.txt');
    expect(request.responseType).toBe('');
    await sendRequest(request);
    expect(request.responseText).toBe('second');
    expect(request.getResponseHeader('content-type')).toBeNull();
  });

  it('reports invalid host response status through the XHR error path', async () => {
    const host = new FakeMiniGameHost();
    host.remoteResponse = { status: 0, data: '{}' };
    const request = new MiniGameXMLHttpRequest(host, {
      allowedRemoteOrigins: ['https://cdn.example.com'],
    });
    request.open('GET', 'https://cdn.example.com/data.json');

    await expect(sendRequest(request)).rejects.toMatchObject({
      event: { type: 'error' },
    });
    expect(request.status).toBe(0);
  });

  it('clears response metadata when host response header inspection fails', async () => {
    const host = new FakeMiniGameHost();
    const headers = new Proxy<Record<string, string>>({}, {
      ownKeys() {
        throw new Error('header inspection failed');
      },
    });
    host.remoteResponse = { status: 200, data: 'partial', headers };
    const request = new MiniGameXMLHttpRequest(host, {
      allowedRemoteOrigins: ['https://cdn.example.com'],
    });
    request.open('GET', 'https://cdn.example.com/partial.txt');

    await expect(sendRequest(request)).rejects.toMatchObject({
      event: { type: 'error' },
    });
    expect(request.status).toBe(0);
    expect(request.responseURL).toBe('');
    expect(request.getAllResponseHeaders()).toBe('');
  });

  it('does not reclassify a successful XHR when its load callback throws', async () => {
    const host = new FakeMiniGameHost();
    host.localFiles.set('assets/value.json', encodeText('{"ok":true}'));
    const listenerError = new Error('consumer load callback failed');
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const request = new MiniGameXMLHttpRequest(host);
    let errorEvents = 0;
    request.open('GET', 'assets/value.json');
    request.responseType = 'json';
    request.onload = () => {
      throw listenerError;
    };
    request.onerror = () => {
      errorEvents += 1;
    };
    const completed = new Promise<void>((resolve) => {
      request.onloadend = () => resolve();
    });

    request.send();
    await completed;

    expect(request.status).toBe(200);
    expect(request.response).toEqual({ ok: true });
    expect(errorEvents).toBe(0);
    expect(reported).toHaveBeenCalledWith(
      expect.stringContaining('load event listener failed'),
      listenerError,
    );
  });

  it.each(['load', 'error'] as const)(
    'stops an old %s lifecycle when its terminal callback starts a replacement request',
    async (terminal) => {
      const host = new FakeMiniGameHost();
      const initialPath = terminal === 'load'
        ? 'assets/initial.json'
        : 'assets/missing.json';
      host.localFiles.set('assets/initial.json', encodeText('{"stage":"initial"}'));
      host.localFiles.set('assets/replacement.json', encodeText('{"stage":"replacement"}'));
      const request = new MiniGameXMLHttpRequest(host);
      const loadendResponses: unknown[] = [];
      let replacementStarted = false;
      let completeReplacement: () => void = () => undefined;
      const completed = new Promise<void>((resolve) => {
        completeReplacement = resolve;
      });
      const startReplacement = (): void => {
        replacementStarted = true;
        request.open('GET', 'assets/replacement.json');
        request.responseType = 'json';
        request.send();
      };
      request.onload = () => {
        if (!replacementStarted && terminal === 'load') {
          startReplacement();
        }
      };
      request.onerror = () => {
        if (!replacementStarted && terminal === 'error') {
          startReplacement();
        }
      };
      request.onloadend = () => {
        loadendResponses.push(request.response);

        if (
          typeof request.response === 'object'
          && request.response !== null
          && Reflect.get(request.response, 'stage') === 'replacement'
        ) {
          completeReplacement();
        }
      };
      request.open('GET', initialPath);
      request.responseType = 'json';

      request.send();
      await completed;

      expect(loadendResponses).toEqual([{ stage: 'replacement' }]);
      expect(request.status).toBe(200);
    },
  );

  it('allows only configured HTTPS origins for remote assets', async () => {
    const host = new FakeMiniGameHost();
    vi.stubGlobal('URL', undefined);
    host.remoteResponse = {
      status: 200,
      data: 'a😀한',
      headers: {
        'content-type': 'application/json',
        'Set-Cookie': 'session=secret',
        'SET-COOKIE2': 'legacy=secret',
      },
    };
    const request = new MiniGameXMLHttpRequest(host, {
      allowedRemoteOrigins: ['https://cdn.example.com'],
    });
    request.open('GET', 'https://cdn.example.com/game/config.json');
    request.responseType = 'text';
    let progressBytes = 0;
    request.onprogress = (event) => {
      progressBytes = event.loaded;
    };
    await sendRequest(request);

    expect(request.responseText).toBe('a😀한');
    expect(progressBytes).toBe(8);
    expect(request.getResponseHeader('Content-Type')).toBe('application/json');
    expect(request.getResponseHeader('Set-Cookie')).toBeNull();
    expect(request.getResponseHeader('Set-Cookie2')).toBeNull();
    expect(request.getAllResponseHeaders()).not.toContain('secret');
    expect(host.remoteRequests).toHaveLength(1);
    expect(classifyMiniGameRequestUrl(
      'HTTPS://CDN.EXAMPLE.COM:443/game/data.json#ignored',
      ['https://cdn.example.com/'],
    )).toEqual({
      kind: 'remote',
      url: 'https://cdn.example.com/game/data.json',
    });
    expect(() => classifyMiniGameRequestUrl(
      'https://unlisted.example.com/file.json',
      ['https://cdn.example.com'],
    )).toThrow('origin is not allowed');
    expect(() => classifyMiniGameRequestUrl('../secret.json')).toThrow(
      'must remain inside the package',
    );
    expect(() => classifyMiniGameRequestUrl('http://cdn.example.com/file.js')).toThrow(
      'only support package paths and allowed HTTPS URLs',
    );
    expect(() => classifyMiniGameRequestUrl('//cdn.example.com/file.json')).toThrow(
      'Protocol-relative mini-game request URLs are not supported',
    );
    expect(() => classifyMiniGameRequestUrl(
      'https://user:secret@cdn.example.com/file.json',
      ['https://cdn.example.com'],
    )).toThrow('must not contain embedded credentials');
    expect(() => classifyMiniGameRequestUrl(
      'https://cdn.example.com/file.json',
      ['https://cdn.example.com#fragment'],
    )).toThrow('must not include a path, query, or fragment');

    const invalidHeader = new MiniGameXMLHttpRequest(host, {
      allowedRemoteOrigins: ['https://cdn.example.com'],
    });
    invalidHeader.open('GET', 'https://cdn.example.com/file.json');
    expect(() => invalidHeader.setRequestHeader('x-test', 'ok\r\ninjected: true')).toThrow(
      'header value contains a line break',
    );
    for (const name of [
      'Cookie',
      'Host',
      'Origin',
      'Content-Length',
      'Connection',
      'Proxy-Authorization',
      'Sec-Fetch-Site',
    ]) {
      expect(() => invalidHeader.setRequestHeader(name, 'blocked')).toThrow(
        'cannot set forbidden request header',
      );
    }
  });
});

describe('Phaser mini-game runtime patch', () => {
  it('forces Canvas config and rejects AUTO or WEBGL input', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const config = createMiniGamePhaserConfig({
      width: 800,
      height: 450,
      loader: { maxParallelDownloads: 4 },
    }, globals);

    expect(config.type).toBe(miniGamePhaserCanvasRenderer);
    expect(config.canvas).toBe(globals.canvas);
    expect(config.loader).toMatchObject({
      maxParallelDownloads: 4,
      imageLoadType: 'HTMLImageElement',
    });
    expect(config.audio).toMatchObject({ noAudio: true });
    expect(() => createMiniGamePhaserConfig({ type: 0 }, globals)).toThrow(
      'AUTO and WEBGL are not supported',
    );
    expect(() => createMiniGamePhaserConfig({ type: 2 }, globals)).toThrow(
      'AUTO and WEBGL are not supported',
    );
  });

  it('rolls back the RAF patch when the initial patched restart throws', () => {
    class FailNextFrameHost extends FakeMiniGameHost {
      failNextFrame = false;

      override requestAnimationFrame(callback: (time: number) => void): number {
        if (this.failNextFrame) {
          this.failNextFrame = false;
          throw new Error('native frame scheduling failed');
        }

        return super.requestAnimationFrame(callback);
      }
    }

    const host = new FailNextFrameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    const originalStep = raf.step;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
      },
      wake() {
        raf.start(raf.callback, false, raf.delay);
        this.running = true;
      },
    };
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
    } satisfies MiniGamePhaserGame;
    raf.start(raf.callback, false, raf.delay);
    host.failNextFrame = true;

    expect(() => installPhaserMiniGameRuntime(game, { globals })).toThrow(
      'native frame scheduling failed',
    );
    expect(raf.step).toBe(originalStep);
    expect(raf.isRunning).toBe(true);
    expect(host.pendingFrameCount).toBe(1);

    const installation = installPhaserMiniGameRuntime(game, { globals });
    expect(raf.step).not.toBe(originalStep);
    installation.dispose();
    expect(raf.step).toBe(originalStep);
  });

  it('patches one RAF loop, survives frame failures, and connects lifecycle once', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const errors: unknown[] = [];
    let frames = 0;
    let pauses = 0;
    let resumes = 0;
    const onFrameError = (error: unknown) => errors.push(error);
    const raf = createFakePhaserRaf(() => {
      frames += 1;

      if (frames === 1) {
        throw new Error('scene frame failed');
      }
    });
    const originalStep = raf.step;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
      },
      wake() {
        raf.start(raf.callback, false, raf.delay);
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        this.isPaused = true;
        pauses += 1;
      },
      resume() {
        this.isPaused = false;
        resumes += 1;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, {
      globals,
      onFrameError,
    });
    const duplicate = installPhaserMiniGameRuntime(game, { globals, onFrameError });

    expect(duplicate).toBe(installation);
    expect(() => installPhaserMiniGameRuntime(game, {
      globals,
      onFrameError: () => undefined,
    })).toThrow('already installed with different runtime options');
    expect(() => globals.dispose()).toThrow(
      'Dispose the Phaser mini-game runtime before disposing mini-game globals',
    );
    expect(globals.disposed).toBe(false);
    expect(getInstalledMiniGameGlobals()).toBe(globals);
    expect(host.pendingFrameCount).toBe(1);
    expect(host.lifecycleListenerCount).toBe(2);
    host.flushFrame(16);
    host.flushFrame(32);
    expect(frames).toBe(2);
    expect(errors).toHaveLength(1);
    expect(host.pendingFrameCount).toBe(1);

    host.emitPause();
    expect(pauses).toBe(1);
    expect(loop.running).toBe(false);
    expect(globals.document.visibilityState).toBe('hidden');
    host.emitResume();
    expect(resumes).toBe(1);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');

    host.emitPause();
    expect(pauses).toBe(2);
    expect(loop.running).toBe(false);
    expect(globals.document.visibilityState).toBe('hidden');
    installation.dispose();
    expect(host.lifecycleListenerCount).toBe(0);
    expect(resumes).toBe(2);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');
    expect(raf.step).toBe(originalStep);
    expect(host.pendingFrameCount).toBe(1);
    host.flushFrame(48);
    expect(frames).toBe(3);
    expect(host.pendingFrameCount).toBe(1);
  });

  it.each([
    {
      priorState: 'manual game pause',
      initiallyPaused: true,
      initiallyRunning: true,
      expected: { sleeps: 1, wakes: 1, pauses: 0, resumes: 0 },
    },
    {
      priorState: 'sleeping loop',
      initiallyPaused: false,
      initiallyRunning: false,
      expected: { sleeps: 0, wakes: 0, pauses: 1, resumes: 1 },
    },
  ])('preserves a pre-existing $priorState across host backgrounding', ({
    initiallyPaused,
    initiallyRunning,
    expected,
  }) => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let sleeps = 0;
    let wakes = 0;
    let pauses = 0;
    let resumes = 0;
    const loop = {
      started: true,
      running: initiallyRunning,
      forceSetTimeOut: false,
      raf,
      sleep() {
        sleeps += 1;
        this.running = false;
      },
      wake() {
        wakes += 1;
        this.running = true;
      },
    };
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: initiallyPaused,
      pause() {
        pauses += 1;
        this.isPaused = true;
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });

    host.emitPause();
    host.emitResume();

    expect({ sleeps, wakes, pauses, resumes }).toEqual(expected);
    expect(loop.running).toBe(initiallyRunning);
    expect(game.isPaused).toBe(initiallyPaused);

    installation.dispose();
  });

  it('rejects multiple active Phaser games on the same mini-game globals', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const createGame = (): MiniGamePhaserGame => {
      const raf = createFakePhaserRaf(() => undefined);

      return {
        config: { renderType: 1 },
        renderer: { type: 1 },
        canvas: globals.canvas,
        loop: {
          started: false,
          running: false,
          forceSetTimeOut: false,
          raf,
          sleep: () => undefined,
          wake: () => undefined,
        },
      };
    };
    const firstGame = createGame();
    const secondGame = createGame();
    const firstInstallation = installPhaserMiniGameRuntime(firstGame, { globals });

    expect(() => installPhaserMiniGameRuntime(secondGame, { globals })).toThrow(
      'only one active Phaser game runtime',
    );

    firstInstallation.dispose();
    const secondInstallation = installPhaserMiniGameRuntime(secondGame, { globals });
    expect(secondInstallation.disposed).toBe(false);
    secondInstallation.dispose();
  });

  it('does not apply pause after a visibility listener disposes the runtime', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let pauses = 0;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        this.running = false;
      },
      wake() {
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        pauses += 1;
        this.isPaused = true;
      },
      resume() {
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });
    globals.document.addEventListener('visibilitychange', () => {
      if (globals.document.hidden) {
        installation.dispose();
      }
    });

    host.emitPause();

    expect(installation.disposed).toBe(true);
    expect(pauses).toBe(0);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');
    expect(host.lifecycleListenerCount).toBe(0);
    expect(host.pendingFrameCount).toBe(1);
  });

  it('restores a game pause when the pause callback disposes the runtime', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let pauses = 0;
    let resumes = 0;
    let sleeps = 0;
    let installation: ReturnType<typeof installPhaserMiniGameRuntime>;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        sleeps += 1;
        this.running = false;
      },
      wake() {
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        pauses += 1;
        this.isPaused = true;
        installation.dispose();
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    installation = installPhaserMiniGameRuntime(game, { globals });

    host.emitPause();

    expect(installation.disposed).toBe(true);
    expect(pauses).toBe(1);
    expect(resumes).toBe(1);
    expect(sleeps).toBe(0);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');
    expect(host.pendingFrameCount).toBe(1);
  });

  it('retains pause ownership when Phaser pause throws after mutating state', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let resumes = 0;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        this.running = false;
      },
      wake() {
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        this.isPaused = true;
        throw new Error('pause listener failed');
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });

    expect(() => host.emitPause()).toThrow('pause listener failed');
    expect(game.isPaused).toBe(true);
    expect(globals.document.visibilityState).toBe('hidden');

    host.emitResume();
    expect(resumes).toBe(1);
    expect(game.isPaused).toBe(false);
    expect(globals.document.visibilityState).toBe('visible');

    installation.dispose();
  });

  it('retains loop ownership when Phaser sleep throws after stopping', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let wakes = 0;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
        throw new Error('sleep listener failed');
      },
      wake() {
        wakes += 1;
        raf.start(raf.callback, false, raf.delay);
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        this.isPaused = true;
      },
      resume() {
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });

    expect(() => host.emitPause()).toThrow('sleep listener failed');
    expect(loop.running).toBe(false);
    expect(game.isPaused).toBe(true);
    expect(globals.document.visibilityState).toBe('hidden');

    host.emitResume();
    expect(wakes).toBe(1);
    expect(loop.running).toBe(true);
    expect(game.isPaused).toBe(false);
    expect(globals.document.visibilityState).toBe('visible');

    installation.dispose();
  });

  it('restores host-owned pause state when wake disposes the runtime', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let pauses = 0;
    let resumes = 0;
    let installation: ReturnType<typeof installPhaserMiniGameRuntime>;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
      },
      wake() {
        raf.start(raf.callback, false, raf.delay);
        this.running = true;
        installation.dispose();
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        pauses += 1;
        this.isPaused = true;
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    installation = installPhaserMiniGameRuntime(game, { globals });

    host.emitPause();
    host.emitResume();

    expect(installation.disposed).toBe(true);
    expect(pauses).toBe(1);
    expect(resumes).toBe(1);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');
    expect(host.pendingFrameCount).toBe(1);
  });

  it('retains pause ownership when the host pauses again during wake', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let pauses = 0;
    let resumes = 0;
    let sleeps = 0;
    let rePauseOnWake = true;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        sleeps += 1;
        raf.stop();
        this.running = false;
      },
      wake() {
        raf.start(raf.callback, false, raf.delay);
        this.running = true;

        if (rePauseOnWake) {
          rePauseOnWake = false;
          host.emitPause();
        }
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        pauses += 1;
        this.isPaused = true;
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });

    host.emitPause();
    host.emitResume();

    expect(pauses).toBe(1);
    expect(resumes).toBe(0);
    expect(sleeps).toBe(2);
    expect(game.isPaused).toBe(true);
    expect(loop.running).toBe(false);
    expect(globals.document.visibilityState).toBe('hidden');

    host.emitResume();
    expect(resumes).toBe(1);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');

    installation.dispose();
  });

  it('retains host resume state when loop wake throws and allows retry', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let failWake = true;
    let resumes = 0;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
      },
      wake() {
        if (failWake) {
          failWake = false;
          throw new Error('wake listener failed');
        }

        raf.start(raf.callback, false, raf.delay);
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        this.isPaused = true;
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });
    host.emitPause();

    expect(() => host.emitResume()).toThrow('wake listener failed');
    expect(resumes).toBe(0);
    expect(game.isPaused).toBe(true);
    expect(loop.running).toBe(false);
    expect(globals.document.visibilityState).toBe('hidden');

    host.emitResume();
    expect(resumes).toBe(1);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');

    installation.dispose();
  });

  it('retains game pause ownership when Phaser resume throws and allows retry', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let failResume = true;
    let resumes = 0;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
      },
      wake() {
        raf.start(raf.callback, false, raf.delay);
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        this.isPaused = true;
      },
      resume() {
        resumes += 1;

        if (failResume) {
          failResume = false;
          throw new Error('resume listener failed');
        }

        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });
    host.emitPause();

    expect(() => host.emitResume()).toThrow('resume listener failed');
    expect(resumes).toBe(1);
    expect(game.isPaused).toBe(true);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('hidden');

    host.emitResume();
    expect(resumes).toBe(2);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(globals.document.visibilityState).toBe('visible');

    installation.dispose();
  });

  it('finishes runtime teardown when host pause restoration throws', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    const originalStep = raf.step;
    let resumes = 0;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
      },
      wake() {
        throw new Error('wake failed');
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        this.isPaused = true;
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;
    const installation = installPhaserMiniGameRuntime(game, { globals });
    host.emitPause();

    expect(() => installation.dispose()).toThrow('wake failed');
    expect(installation.disposed).toBe(true);
    expect(resumes).toBe(1);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(false);
    expect(globals.document.visibilityState).toBe('visible');
    expect(host.lifecycleListenerCount).toBe(0);
    expect(raf.step).toBe(originalStep);
    expect(() => globals.dispose()).not.toThrow();
    expect(globals.disposed).toBe(true);
  });

  it('keeps one RAF chain when the runtime is disposed inside a frame callback', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    let frames = 0;
    let installation: ReturnType<typeof installPhaserMiniGameRuntime>;
    const raf = createFakePhaserRaf(() => {
      frames += 1;
      installation.dispose();
    });
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        this.running = false;
      },
      wake() {
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
    } satisfies MiniGamePhaserGame;
    installation = installPhaserMiniGameRuntime(game, { globals });

    host.flushFrame(16);
    expect(installation.disposed).toBe(true);
    expect(frames).toBe(1);
    expect(host.pendingFrameCount).toBe(1);

    host.flushFrame(32);
    expect(frames).toBe(2);
    expect(host.pendingFrameCount).toBe(1);
  });

  it('requires an explicitly configured Canvas renderer', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    const gameWithoutRendererConfig = {
      canvas: globals.canvas,
      loop: {
        started: false,
        running: false,
        forceSetTimeOut: false,
        raf,
        sleep: () => undefined,
        wake: () => undefined,
      },
    } satisfies MiniGamePhaserGame;

    expect(() => installPhaserMiniGameRuntime(gameWithoutRendererConfig, { globals })).toThrow(
      'explicit Canvas renderer',
    );
  });

  it('requires the Phaser game to use the globals primary canvas', () => {
    const host = new FakeMiniGameHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.document.createElement('canvas'),
      loop: {
        started: false,
        running: false,
        forceSetTimeOut: false,
        raf,
        sleep: () => undefined,
        wake: () => undefined,
      },
    } satisfies MiniGamePhaserGame;

    expect(() => installPhaserMiniGameRuntime(game, { globals })).toThrow(
      'must use the globals installation primary canvas',
    );
    expect(raf.isRunning).toBe(false);
    expect(host.lifecycleListenerCount).toBe(0);
  });

  it('requires lifecycle pause and resume hooks as a pair', () => {
    const host = new FakeMiniGameHost();
    Reflect.set(host, 'onResume', undefined);
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    const originalStep = raf.step;
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop: {
        started: false,
        running: false,
        forceSetTimeOut: false,
        raf,
        sleep: () => undefined,
        wake: () => undefined,
      },
    } satisfies MiniGamePhaserGame;

    expect(() => installPhaserMiniGameRuntime(game, { globals })).toThrow(
      'must provide onPause and onResume together',
    );
    expect(raf.step).toBe(originalStep);
    expect(host.lifecycleListenerCount).toBe(0);
  });

  it('rolls back the RAF patch when lifecycle subscription fails', () => {
    class InvalidLifecycleHost extends FakeMiniGameHost {
      override onResume(_callback: () => void): () => void {
        throw new Error('resume subscription failed');
      }
    }

    const host = new InvalidLifecycleHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    const originalStep = raf.step;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep: () => undefined,
      wake: () => undefined,
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
    } satisfies MiniGamePhaserGame;

    expect(() => installPhaserMiniGameRuntime(game, { globals })).toThrow(
      'resume subscription failed',
    );
    expect(raf.step).toBe(originalStep);
    expect(host.lifecycleListenerCount).toBe(0);
    expect(host.pendingFrameCount).toBe(1);
  });

  it('deactivates an unremovable lifecycle callback after installation fails', () => {
    class LeakyLifecycleHost extends FakeMiniGameHost {
      override onPause(callback: () => void): () => void {
        super.onPause(callback);
        callback();
        return undefined as never;
      }
    }

    const host = new LeakyLifecycleHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let pauses = 0;
    let resumes = 0;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        this.running = false;
      },
      wake() {
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        pauses += 1;
        this.isPaused = true;
      },
      resume() {
        resumes += 1;
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;

    expect(() => installPhaserMiniGameRuntime(game, { globals })).toThrow(
      'must return an unsubscribe function',
    );
    expect(host.lifecycleListenerCount).toBe(1);
    expect(pauses).toBe(1);
    expect(resumes).toBe(1);
    expect(globals.document.visibilityState).toBe('visible');
    host.emitPause();
    expect(pauses).toBe(1);
    expect(resumes).toBe(1);
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(host.pendingFrameCount).toBe(1);
  });

  it('observes game destruction before subscribing to synchronous host lifecycle hooks', () => {
    class ImmediatePauseHost extends FakeMiniGameHost {
      override onPause(callback: () => void): () => void {
        const unsubscribe = super.onPause(callback);
        callback();
        return unsubscribe;
      }
    }

    const host = new ImmediatePauseHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    const originalStep = raf.step;
    let destroyListener: (() => void) | undefined;
    const events = {
      once(event: string, callback: () => void) {
        if (event === 'destroy') {
          destroyListener = callback;
        }
      },
      off(event: string, callback: () => void) {
        if (event === 'destroy' && destroyListener === callback) {
          destroyListener = undefined;
        }
      },
    };
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
      },
      wake() {
        raf.start(raf.callback, false, raf.delay);
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      events,
      isPaused: false,
      pause() {
        this.isPaused = true;
        destroyListener?.();
      },
      resume() {
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;

    expect(() => installPhaserMiniGameRuntime(game, { globals })).toThrow(
      'destroyed while the mini-game runtime was installing',
    );
    expect(host.lifecycleListenerCount).toBe(0);
    expect(globals.document.visibilityState).toBe('visible');
    expect(raf.step).toBe(originalStep);
    expect(host.pendingFrameCount).toBe(1);
    expect(() => globals.dispose()).not.toThrow();
  });

  it('rejects reentrant installation from a synchronous lifecycle callback', () => {
    class ImmediatePauseHost extends FakeMiniGameHost {
      override onPause(callback: () => void): () => void {
        const unsubscribe = super.onPause(callback);
        callback();
        return unsubscribe;
      }
    }

    const host = new ImmediatePauseHost();
    const globals = installMiniGameGlobals(host);
    const raf = createFakePhaserRaf(() => undefined);
    let reentrantError: unknown;
    const loop = {
      started: true,
      running: true,
      forceSetTimeOut: false,
      raf,
      sleep() {
        raf.stop();
        this.running = false;
      },
      wake() {
        raf.start(raf.callback, false, raf.delay);
        this.running = true;
      },
    };
    raf.start(raf.callback, false, raf.delay);
    const game = {
      config: { renderType: 1 },
      renderer: { type: 1 },
      canvas: globals.canvas,
      loop,
      isPaused: false,
      pause() {
        this.isPaused = true;

        try {
          installPhaserMiniGameRuntime(this, { globals });
        } catch (error) {
          reentrantError = error;
        }
      },
      resume() {
        this.isPaused = false;
      },
    } satisfies MiniGamePhaserGame;

    const installation = installPhaserMiniGameRuntime(game, { globals });
    expect(reentrantError).toMatchObject({
      code: 'MINIGAME_PHASER_INSTALL_REENTRANT',
    });
    expect(host.lifecycleListenerCount).toBe(2);
    expect(host.pendingFrameCount).toBe(0);

    installation.dispose();
    expect(game.isPaused).toBe(false);
    expect(loop.running).toBe(true);
    expect(host.lifecycleListenerCount).toBe(0);
    expect(host.pendingFrameCount).toBe(1);
  });
});

function sendRequest(request: MiniGameXMLHttpRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onload = (event) => {
      try {
        expect(event.target).toBe(request);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = (event) => reject(Object.assign(new Error('Request failed'), { event }));
    request.ontimeout = (event) => reject(Object.assign(new Error('Request timed out'), { event }));
    request.send();
  });
}

function createFakePhaserRaf(callback: (time: number) => void) {
  return {
    isRunning: false,
    isSetTimeOut: false,
    timeOutID: null as number | null,
    delay: 16,
    callback,
    step(time: number) {
      this.callback(time);

      if (this.isRunning) {
        this.timeOutID = globalThis.requestAnimationFrame(this.step.bind(this));
      }
    },
    start(nextCallback: (time: number) => void, _forceSetTimeOut: boolean, delay: number) {
      if (this.isRunning) {
        return;
      }

      this.callback = nextCallback;
      this.delay = delay;
      this.isRunning = true;
      this.timeOutID = globalThis.requestAnimationFrame(this.step.bind(this));
    },
    stop() {
      this.isRunning = false;

      if (this.timeOutID !== null) {
        globalThis.cancelAnimationFrame(this.timeOutID);
      }
    },
  };
}
